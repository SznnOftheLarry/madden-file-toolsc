const TDB2File = require('../../filetypes/TDB2/TDB2File');
const utilService = require('../../services/utilService');
const TDB2Table = require('../../filetypes/TDB2/TDB2Table');
const TDB2Record = require('../../filetypes/TDB2/TDB2Record');
const TDB2Field = require('../../filetypes/TDB2/TDB2Field');
const FileParser = require('../../filetypes/abstract/FileParser');
const {SimpleParser} = require('../../filetypes/abstract/SimpleParser');
const zlib = require('zlib');

const FIELD_TYPE_INT = 0;
const FIELD_TYPE_STRING = 1;
const FIELD_TYPE_UNK = 3;
const FIELD_TYPE_SUBTABLE = 4;
const FIELD_TYPE_SUBTABLE_COMPRESSED = 5;
const FIELD_TYPE_FLOAT = 10;

class TDB2Parser extends FileParser {
    constructor(options = {}) {
        super();
        this.file = new TDB2File();
        // Uncompressed TDB2 payload length from the FBCH header (offset 0x12).
        // Used so trailing records that omit a final terminator at EOF still complete.
        this._expectedLength = options.expectedLength || 0;
        this.bytes(0x5, this._onTableStart);
    };

    get expectedLength() {
        return this._expectedLength;
    };

    set expectedLength(value) {
        this._expectedLength = value;
    };

    _onTableStart(buf) {
        let table = new TDB2Table();
        table.offset = this.currentBufferIndex - 5;
        table.rawKey = buf.slice(0, 5)
        table.name = utilService.getUncompressedTextFromSixBitCompression(buf.slice(0, 3));
        table.type = buf.readUInt8(3);
        table.unknown1 = buf.readUInt8(4);

        this.bytes(0x1, function (buf) {
            if(table.type === 0x5)
            {
                table.unknown2 = buf.readUInt8(0);
                this.bytes(0x1, (buf2) => {
                    this._readLebNumber(buf2, (numEntriesBuf) => {
                        table.numEntriesRaw = numEntriesBuf;
                        this._onTableRecordStart(table);
                    });
                });
            }
            else if(table.type === 0x3) // Table type 3 seems to be basically the same as 4, but the header has some extra bytes before the record count
            {
                this.bytes(0x3, (extraKeyBuf) => {
                    table.rawKey = Buffer.concat([table.rawKey, buf, extraKeyBuf]);
                    this.bytes(0x1, (buf2) => {
                        this._readLebNumber(buf2, (numEntriesBuf) => {
                            table.numEntriesRaw = numEntriesBuf;
                            this._onTableRecordStart(table);
                        });
                    });
                });
            }
            else
            {
                this._readLebNumber(buf, (numEntriesBuf) => {
                    table.numEntriesRaw = numEntriesBuf;
                    this._onTableRecordStart(table);
                });
            }
        });
    };

    _getLebRecordKey(record, table) {
        this.bytes(0x1, (buf) => {
            this._readLebNumber(buf, (lebBuf) => {
                record.index = utilService.readModifiedLebCompressedInteger(lebBuf);

                // Unknown 2 is the store type. 2 represents gzip compressed record data, while 3 is uncompressed
                if(table.unknown2 === 0x2)
                {
                    // Read LEB number for compressed byte size
                    this.bytes(0x1, (numBytesBuf) => {
                        this._readLebNumber(numBytesBuf, (lebBytesBuf) => {
                            const bytesToRead = utilService.readModifiedLebCompressedInteger(lebBytesBuf);
                            this.bytes(bytesToRead, (compressedRecordBuf) => {
                                this._onCompressedTableFieldStart(compressedRecordBuf, record, table)
                            });
                        });
                    });
                }
                else
                {
                    this._onTableFieldStart(record, table);
                }
            });
        });
    }

    _onTableRecordStart(table) {
        let record = new TDB2Record();
        record.index = table.type === 5 ? this._getLebRecordKey(record, table) : table.records.length;
        if(table.type !== 5)
            this._onTableFieldStart(record, table);
    };

    _onCompressedTableFieldStart(compressedRecordBuf, record, table, existingParser) {
        const recordParser = new SimpleParser(zlib.gunzipSync(compressedRecordBuf));
        recordParser.readBytes(4); // Skip the header bytes

        // Quick and dirty check for M26 subrecord format based on table name. 
        // Should probably come up with a better way to detect M26, but it works for now
        if(table.name === 'BLBM' || table.name === 'BLOB')
        {
            // Subrecord header (always exists, even when there's no actual subrecord data)
            recordParser.readBytes(4);

            // Another quick and dirty check to check if we have a subrecord to read
            if(recordParser.buffer[recordParser.offset] !== 0 && recordParser.buffer[recordParser.offset] !== 0x8E)
            {
                let subRecord = new TDB2Record();
                subRecord.index = 0; // There's really no need for an index here, since every record has at most one subrecord and this isn't tied to a table
                subRecord.parentRecord = record;
                record.subRecord = subRecord;

                this._onDecompressedTableFieldStart(recordParser, subRecord, table);
            }
            else
            {
                // When there's no subrecord, there's 2 null bytes and then the 4 byte header
                recordParser.readBytes(2);
                recordParser.readBytes(4);
                this._onDecompressedTableFieldStart(recordParser, record, table);
            }
        }
        else
        {
            this._onDecompressedTableFieldStart(recordParser, record, table);
        }
    };

    _assignField(record, field) {
        // CFB 27 BLOB records can repeat the same field key (e.g. two BLBM tables).
        // Keep the first under the original name; store later copies as KEY2, KEY3, ...
        // field.key / field.rawKey stay as in the file so writes still emit the real name.
        for (const existingKey of Object.keys(record.fields)) {
            if (record.fields[existingKey] === field) {
                return existingKey;
            }
        }

        let storageKey = field.key;
        if (record.fields.hasOwnProperty(storageKey)) {
            let suffix = 2;
            while (record.fields.hasOwnProperty(field.key + suffix)) {
                suffix++;
            }
            storageKey = field.key + suffix;
        }
        record.fields[storageKey] = field;
        return storageKey;
    }

    _onDecompressedTableFieldStart(recordParser, record, table)
    {
        // Some BLBM/BLOB records (seen in CFB 27 and some M26-style saves) have a
        // subrecord but no main fields after the CHVI header — only a terminator.
        // Treat an immediate null as an empty record body instead of reading a field.
        if (recordParser.buffer.readUInt8(recordParser.offset) === 0x0) {
            return this._checkCompressedTableRecordEnd(record, table, recordParser);
        }

        let field = new TDB2Field();
        field.rawKey = recordParser.readBytes(4);
        field.key = utilService.getUncompressedTextFromSixBitCompression(field.rawKey.slice(0, 3));
        field.type = field.rawKey.slice(3).readUInt8(0);

        // Subrecord fields (M26/CFB mid-section) must not pollute the parent table's
        // field definitions — otherwise _normalizeRecords invents stub main fields.
        if (!record.isSubRecord) {
            this._populateFieldDefinitions(table, field);
        }

        switch (field.type) {
            case FIELD_TYPE_INT:
                field.raw = utilService.writeModifiedLebCompressedInteger(utilService.parseModifiedLebEncodedNumber(recordParser));
                this._assignField(record, field);

                // M25+ weirdness. The UNWI field is sometimes (but not always) followed by an extra zero byte.
                // It never seems to appear at the end of a record, so checking this way shouldn't cause any issues.
                // The WRST field can appear at the end of a subrecord, but it seems to always have the eztra zero, so that's fine
                if((field.key === 'UNWI' || field.key === 'WRST') && recordParser.buffer[recordParser.offset] === 0)
                {
                    field.raw = Buffer.concat([field.raw, recordParser.readBytes(1)]);

                    this._assignField(record, field);
                }
                return this._checkCompressedTableRecordEnd(record, table, recordParser);
            case FIELD_TYPE_STRING:
                const strLen = utilService.parseModifiedLebEncodedNumber(recordParser);
                field.length = strLen;
                field.raw = recordParser.readBytes(strLen);
                this._assignField(record, field);
                return this._checkCompressedTableRecordEnd(record, table, recordParser);
            case FIELD_TYPE_UNK:
                // M25+ rosters decided to be weird, sometimes they have a 0 byte after this type byte, other times they don't.
                // This field type generally never appears at the end of a record, so checking this way shouldn't cause any issues
                field.raw = recordParser.buffer[recordParser.offset] === 0 ? recordParser.readBytes(1) : Buffer.alloc(0);
                this._assignField(record, field);
                return this._checkCompressedTableRecordEnd(record, table, recordParser);
            case FIELD_TYPE_SUBTABLE:
                // Read subtable header information
                field.value = new TDB2Table();
                field.value.offset = recordParser.offset - 4;
                field.value.rawKey = field.rawKey;
                field.value.name = field.key;
                field.value.type = field.type;
                field.value.unknown1 = recordParser.readByte().readUInt8(0);
                field.value.numEntriesRaw = utilService.writeModifiedLebCompressedInteger(utilService.parseModifiedLebEncodedNumber(recordParser));
                field.value.isSubTable = true;
                field.value.parentInfo = { parentRecord: record, parentField: field, parentTable: table };

                // Read subtable records
                this._readCompressedRecordSubTable(field.value, recordParser);
                this._assignField(record, field);
                return this._checkCompressedTableRecordEnd(record, table, recordParser);
            case FIELD_TYPE_FLOAT:
                field.raw = recordParser.readBytes(4);
                this._assignField(record, field);
                return this._checkCompressedTableRecordEnd(record, table, recordParser);
            default:
                console.warn(`Unsupported field type: 0x${field.type.toString(16)} at index 0x${this.currentBufferIndex.toString(16)}`);
        }
    };

    _readCompressedRecordSubTable(table, recordParser)
    {
        for(let i = 0; i < table.numEntries; i++)
        {
            let record = new TDB2Record();
            record.index = i;
            while(recordParser.buffer.readUInt8(recordParser.offset) !== 0x0)
            {
                let field = new TDB2Field();
                field.rawKey = recordParser.readBytes(4);
                field.key = utilService.getUncompressedTextFromSixBitCompression(field.rawKey.slice(0, 3));
                field.type = field.rawKey.slice(3).readUInt8(0);

                this._populateFieldDefinitions(table, field);

                switch (field.type) {
                    case FIELD_TYPE_INT:
                        field.raw = utilService.writeModifiedLebCompressedInteger(utilService.parseModifiedLebEncodedNumber(recordParser));
                        this._assignField(record, field);
                        break;
                    case FIELD_TYPE_STRING:
                        const strLen = utilService.parseModifiedLebEncodedNumber(recordParser);
                        field.length = strLen;
                        field.raw = recordParser.readBytes(strLen);
                        this._assignField(record, field);
                        break;
                    case FIELD_TYPE_UNK:
                        field.raw = Buffer.alloc(0);
                        this._assignField(record, field);
                        break;
                    case FIELD_TYPE_SUBTABLE:
                        field.value = new TDB2Table();
                        field.value.offset = recordParser.offset - 4;
                        field.value.rawKey = field.rawKey;
                        field.value.name = field.key;
                        field.value.type = field.type;
                        field.value.unknown1 = recordParser.readByte().readUInt8(0);
                        field.value.numEntriesRaw = utilService.writeModifiedLebCompressedInteger(utilService.parseModifiedLebEncodedNumber(recordParser));
                        field.value.isSubTable = true;
                        field.value.parentInfo = { parentRecord: record, parentField: field, parentTable: table };
                        this._assignField(record, field);
                        this._readCompressedRecordSubTable(field.value, recordParser);
                        break;
                    case FIELD_TYPE_FLOAT:
                        field.raw = recordParser.readBytes(4);
                        this._assignField(record, field);
                        break;
                    default:
                        console.warn(`Unsupported field type found in subtable at index 0x${recordParser.offset.toString(16)}`);
                }
            }

            this._pushTableRecord(record, table);

            recordParser.readBytes(1);
        }
    }

    _checkCompressedTableRecordEnd(record, table, recordParser)
    {
        if (recordParser.buffer.readUInt8(recordParser.offset) === 0x0) {
            // Subrecords work purely by a reference from the parent record, so don't push to table
            if(!record.isSubRecord)
            {
                this._pushTableRecord(record, table);
            }

            // Read record terminator null byte
            recordParser.readBytes(1);

            // If it's the end of the subrecord, we still need to read the parent record afterward
            if(record.isSubRecord)
            {
                // CFB 27 (and some BLBM layouts) keep the no-subrecord `00 00` padding
                // before CHVI even when mid-section/subrecord fields are present.
                while (recordParser.offset < recordParser.buffer.length &&
                    recordParser.buffer.readUInt8(recordParser.offset) === 0x0) {
                    recordParser.readBytes(1);
                }

                recordParser.readBytes(4); // Read CHVI header
                this._onDecompressedTableFieldStart(recordParser, record.parentRecord, table);
            }
            else
            {
                this._checkTableEnd(table);
            }
        }
        else {
            this._onDecompressedTableFieldStart(recordParser, record, table);
        }
    }

    _pushTableRecord(record, table)
    {
        table.records.push(new Proxy(record, {
            get: function (target, prop, receiver) {
                return record.fields[prop] !== undefined ? record.fields[prop].value : record[prop] !== undefined ? record[prop] : null;
            },
            set: function (target, prop, receiver) {
                if (record.fields[prop] !== undefined) {
                    record.fields[prop].value = receiver;
                }
                else {
                    record[prop] = receiver;
                }

                return true;
            }
        }));
    };


    _onTableFieldStart(record, table, startTableBuf) {
        const bytesToRead = startTableBuf ? 0x5 - (startTableBuf.length) : 0x5;
        this.bytes(bytesToRead, (tableKeyBuf) => {
            if (startTableBuf) {
                tableKeyBuf = Buffer.concat([startTableBuf, tableKeyBuf]);
            }
            
            let field = new TDB2Field();
            field.rawKey = tableKeyBuf.slice(0, 4);
            field.key = utilService.getUncompressedTextFromSixBitCompression(tableKeyBuf.slice(0, 3));
            field.type = tableKeyBuf.readUInt8(3);

            this._populateFieldDefinitions(table, field);

            switch (field.type) {
                case FIELD_TYPE_INT:
                    return this._readLebNumber(tableKeyBuf.slice(4), (fieldBuffer) => {
                        field.raw = fieldBuffer;
                        this._assignField(record, field);

                        // UNWI (also the TREF field in M26) has an extra zero for some reason
                        if(field.key === 'UNWI' || field.key === 'TREF')
                        {
                            this.bytes(0x1, (buf) => {
                                field.raw = Buffer.concat([fieldBuffer, buf]);
                                this._assignField(record, field);
                                this._checkTableRecordEnd(record, table);
                            });
                        }
                        else
                        {
                            this._checkTableRecordEnd(record, table);
                        }
                    });
                case FIELD_TYPE_STRING:
                        const firstNumByte = tableKeyBuf.slice(4);
                        // If the first byte is 0x80 or higher, we need to use different logic
                        if (firstNumByte.readUInt8(0) >= 0x80) {
                            return this.bytes(0x1, (buf) => {
                                this._readLebNumber(Buffer.concat([tableKeyBuf.slice(4), buf]), (strLenBuf) => {
                                    const strLen = utilService.readModifiedLebCompressedInteger(strLenBuf);
                                    field.length = strLen;
                                    this.bytes(strLen, (strBuf) => {
                                        field.raw = strBuf;
                                        this._assignField(record, field);
                                        this._checkTableRecordEnd(record, table);
                                    });
                                });
                            });
                        }
                        else {
                            const strLen = firstNumByte.readUInt8(0);
                            field.length = strLen;
                            return this.bytes(strLen, (strBuf) => {
                                field.raw = strBuf;
                                this._assignField(record, field);
                                this._checkTableRecordEnd(record, table);
                            });
                        }
                case FIELD_TYPE_UNK:
                    return this.bytes(0x1, (buf) => {
                       const excessBuf = Buffer.concat([tableKeyBuf.slice(4), buf]);
                       field.raw = Buffer.alloc(0);
                       this._assignField(record, field);
                       
                       this._onTableFieldStart(record, table, excessBuf);
                    });
                case FIELD_TYPE_SUBTABLE:
                case FIELD_TYPE_SUBTABLE_COMPRESSED: // Most of the logic is the same for both subtable types
                    return this.bytes(0x1, (buf) => {
                        field.value = new TDB2Table();
                        field.value.offset = this.currentBufferIndex - 6;
                        field.value.rawKey = field.rawKey;
                        field.value.name = field.key;
                        field.value.type = field.type;
                        field.value.unknown1 = tableKeyBuf.readUInt8(4);

                        if(field.type === FIELD_TYPE_SUBTABLE_COMPRESSED) // Field type 5 will have the extra storage type byte just like table type 5
                        {
                            // Read the store type byte
                            field.value.unknown2 = buf.readUInt8(0);

                            this.bytes(0x1, (buf2) => {
                                this._readLebNumber(buf2, (numEntriesBuf) => {
                                    field.value.numEntriesRaw = numEntriesBuf;
                                    field.value.isSubTable = true;
                                    field.value.parentInfo = { parentRecord: record, parentField: field, parentTable: table };
                                    this._assignField(record, field);
                                    this._onTableRecordStart(field.value);
                                });
                            });

                        }
                        else
                        {
                            this._readLebNumber(buf, (numEntriesBuf) => {
                                field.value.numEntriesRaw = numEntriesBuf;
                                field.value.isSubTable = true;
                                field.value.parentInfo = { parentRecord: record, parentField: field, parentTable: table };
                                this._assignField(record, field);
                                
                                this._onTableRecordStart(field.value);
                            });
                        }
                    });
                case FIELD_TYPE_FLOAT:
                    return this.bytes(0x3, (restOfFloatBuf) => {
                        const fieldBuffer = Buffer.concat([tableKeyBuf.slice(4), restOfFloatBuf])
                        field.raw = fieldBuffer;
                        this._assignField(record, field);

                        this._checkTableRecordEnd(record, table);
                    });
                default:
                    console.warn(`Unsupported field type: 0x${field.type.toString(16)} at index 0x${this.currentBufferIndex.toString(16)}`);
            }
        });
    };

    _checkTableRecordEnd(record, table) {
        // CFB 27 roster payloads may end immediately after the last nested table
        // without a trailing record terminator byte. Treat payload EOF as end-of-record.
        if (this._expectedLength > 0 && this.currentBufferIndex >= this._expectedLength) {
            this._pushTableRecord(record, table);
            this._checkTableEnd(table);
            return;
        }

        this.bytes(0x1, (buf) => {
            if (buf.readUInt8(0) === 0x0) {
                this._pushTableRecord(record, table);

                this._checkTableEnd(table);
            }
            else {
                this._onTableFieldStart(record, table, buf);
            }
        });
    };

    _populateFieldDefinitions(table, field)
    {
        if (!table.fieldDefinitions.find((f) => f.name === field.key)) {
            const newFieldDef = {
                'name': field.key,
                'type': field.type,
                'offset': -1,
                'bits': -1,
                'maxValue': -1
            }

            table.fieldDefinitions.push(newFieldDef);
        }
    }

    _normalizeRecords(table) {
        // Iterate through the records and add any missing fields that are present in some records but not all
        for (let i = 0; i < table.records.length; i++) {
            const record = table.records[i];
            for (let key in table.fieldDefinitions) {
                const fieldDef = table.fieldDefinitions[key];
                if (!record.fields.hasOwnProperty(fieldDef.name)) {
                    // Skip subtables as they could become a little tricky and don't really need this right now
                    if(fieldDef.type === FIELD_TYPE_SUBTABLE || fieldDef.type === FIELD_TYPE_SUBTABLE_COMPRESSED)
                    {
                        continue;
                    }

                    const newField = new TDB2Field();

                    newField.key = fieldDef.name;
                    newField.type = fieldDef.type;
                    newField.rawKey = Buffer.from([...utilService.compress6BitString(fieldDef.name), fieldDef.type]);

                    // Set default values for the field based on type
                    switch (fieldDef.type) {
                        case FIELD_TYPE_INT:
                            newField.value = 0;
                            break;
                        case FIELD_TYPE_STRING:
                            newField.value = '';
                            break;
                        case FIELD_TYPE_UNK:
                            newField.raw = Buffer.from([0x0]);
                            break;
                        case FIELD_TYPE_FLOAT:
                            newField.value = 0.0;
                            break;
                        default:
                            console.warn(`Unsupported field type: 0x${fieldDef.type.toString(16)}`);
                    }

                    // It's not really changed since this is being done while reading
                    newField.isChanged = false;
                    
                    record.fields[fieldDef.name] = newField;
                }
            }
        }
    }

    _checkTableEnd(table) {
        if (table.records.length === table.numEntries) {
            if(table.isSubTable)
            {
                const parentField = table.parentInfo.parentField;
                const parentRecord = table.parentInfo.parentRecord;
                const parentTable = table.parentInfo.parentTable;

                // Remove the parent info from the table
                delete table.parentInfo;

                parentField.value = table;
                this._checkTableRecordEnd(parentRecord, parentTable);
            }
            else
            {
                // Type 3 BLOB wrappers (M26/CFB) can hold heterogeneous records
                // (e.g. appearance BLBM vs PLAY/TEAM). Normalizing shared field
                // defs across them invents stub fields and corrupts saves.
                if (table.type !== 3) {
                    this._normalizeRecords(table);
                }
                this.file.addTable(table);

                // No more tables past the end of the uncompressed payload (CFB 27).
                if (this._expectedLength > 0 && this.currentBufferIndex >= this._expectedLength) {
                    return;
                }

                this.bytes(0x5, this._onTableStart);
            }
        }
        else {
            this._onTableRecordStart(table);
        }
    };

    _readLebNumber(buf, cb) {
        const latestValue = buf.readUInt8(buf.length - 1);

        if (latestValue >= 0x80) {
            this.bytes(0x1, function (buf2) {
                return this._readLebNumber(Buffer.concat([buf, buf2]), cb);
            });
        }
        else {
            cb(buf);
        }
    };
};

module.exports = TDB2Parser;