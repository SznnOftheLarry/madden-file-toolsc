const MaddenRosterHelper = require('./MaddenRosterHelper');

/**
 * College Football 25+ roster files use the same FBCH + zlib + TDB2 container as
 * modern Madden rosters (year field >= 2021, CFB 27 = 2027). This alias exists so
 * CFB tooling can depend on an explicitly named helper.
 */
class CollegeFootballRosterHelper extends MaddenRosterHelper {}

module.exports = CollegeFootballRosterHelper;
