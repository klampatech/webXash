const zipList = [
  {
    // HLDM zip doesn't have c0a0 — must start on a DM map.
    name: "HLDM (85M)",
    packageName: "hldm.zip",
    launchArgs: "+map crossfire +maxplayers 8",
  },
  {
    // Uplink — original Uplink mod entry is hldemo1 (no "uplink" map).
    name: "Uplink (45M)",
    packageName: "uplink.zip",
    launchArgs: "+map hldemo1",
  },
  {
    // Day One — full HL1 SP, has c0a0. Use it as the entry.
    name: "Day One (78M)",
    packageName: "dayone.zip",
    launchArgs: "+map c0a0",
  },
  {
    // The Specialists — ts/ has no valve.rc/liblist.gam of its own,
    // so the engine would fall back to HL1 SP. Force a TS map.
    name: "The Specialists (578M)",
    packageName: "tsmod.zip",
    launchArgs: "-game ts +map ts_apartments",
  },
];

export default zipList;