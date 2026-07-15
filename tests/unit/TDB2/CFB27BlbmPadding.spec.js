const expect = require('chai').expect;
const zlib = require('zlib');
const utilService = require('../../../services/utilService');
const TDB2Parser = require('../../../streams/TDB2/TDB2Parser');
const { PassThrough } = require('stream');

/**
 * Build a tiny TDB2 payload with a type-5 BLBM table containing one compressed
 * record that has mid-section fields, 00 00 padding before CHVI, and an
 * empty main body — the CFB 27 pattern that previously crashed the parser.
 */
function buildCfb27EmptyMainFixture() {
    const chan = Buffer.concat([Buffer.from(utilService.compress6BitString('CHAN')), Buffer.from([0x03])]);
    const chvi = Buffer.concat([Buffer.from(utilService.compress6BitString('CHVI')), Buffer.from([0x03])]);

    // Mid-section: QBCS=6, then end
    const qbcs = Buffer.concat([
        Buffer.from(utilService.compress6BitString('QBCS')),
        Buffer.from([0x00]), // int type
        utilService.writeModifiedLebCompressedInteger(6)
    ]);

    // CHAN CHAN [QBCS] 00 00 CHVI 00  — empty main after CHVI
    const decompressed = Buffer.concat([
        chan, chan,
        qbcs,
        Buffer.from([0x00, 0x00]),
        chvi,
        Buffer.from([0x00])
    ]);
    const compressed = zlib.gzipSync(decompressed);

    // Top-level BLBM type 5, unknown1=0, unknown2=2 (gzip), 1 entry, index 1
    const tableHeader = Buffer.concat([
        Buffer.from(utilService.compress6BitString('BLBM')),
        Buffer.from([0x05, 0x00, 0x02]),
        utilService.writeModifiedLebCompressedInteger(1)
    ]);
    const record = Buffer.concat([
        utilService.writeModifiedLebCompressedInteger(1),
        utilService.writeModifiedLebCompressedInteger(compressed.length),
        compressed
    ]);

    return Buffer.concat([tableHeader, record]);
}

describe('CFB27 TDB2 BLBM empty-main / CHVI padding', () => {
    it('parses BLBM records with mid-section fields, double-null before CHVI, and empty main', (done) => {
        const payload = buildCfb27EmptyMainFixture();
        const parser = new TDB2Parser({ expectedLength: payload.length });
        const pt = new PassThrough();

        parser.on('finish', () => {
            try {
                expect(parser.file.tables.length).to.equal(1);
                expect(parser.file.tables[0].name).to.equal('BLBM');
                expect(parser.file.BLBM.records.length).to.equal(1);
                const record = parser.file.BLBM.records[0];
                expect(record.index).to.equal(1);
                expect(record.subRecord).to.not.equal(null);
                expect(record.subRecord.fields.QBCS.value).to.equal(6);
                expect(record.fields.QBCS).to.equal(undefined);
                expect(record.fields.ASNM).to.equal(undefined);
                done();
            } catch (e) {
                done(e);
            }
        });
        parser.on('error', done);

        pt.pipe(parser);
        pt.end(payload);
    });
});
