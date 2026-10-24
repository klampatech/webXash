// One entry: The Specialists. Other zips (Day One / HLDM / Uplink)
// are stripped from the launcher since the focus is TS.
//
// TS mod has no native WASM client.dll / server.dll — the TS-only
// gameplay (acrobatics, dual-wield, kick, classes) requires a
// ts_i386.so port we don't have. The liblist.gam points gamedll
// to hl.dll (which we DO have as WASM) so the engine boots HL1
// vanilla gameplay on TS maps.
const zipList = [
  {
    name: "The Specialists",
    packageName: "tsmod.zip",
    launchArgs: "-game ts +map ts_apartments",
  },
];

export default zipList;