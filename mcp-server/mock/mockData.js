// Mock PO data simulating SAP ECC responses
const mockPOs = [
  {
    EBELN: "4500017814",
    LIFNR: "0000100023",
    VENDOR_NAME: "Acme Supplies GmbH",
    WAERS: "USD",
    NETWR: 45200.0,
    BEDAT: "20260310",
    FRGKE: "0",
    FRGZU: "",
    EKGRP: "001",
    EKORG: "1000",
    BUKRS: "1000",
    STATUS: "PENDING",
    releaseSteps: [
      { code: "A1", label: "Dept. Manager",    completed: false }
    ],
    items: [
      { EBELP: "00010", TXZ01: "Industrial Pump A200", MENGE: 5,  MEINS: "EA", NETPR: 4500.0, WERKS: "1000" },
      { EBELP: "00020", TXZ01: "Spare Parts Kit",      MENGE: 20, MEINS: "EA", NETPR: 1085.0, WERKS: "1000" }
    ]
  },
  {
    EBELN: "4500017815",
    LIFNR: "0000200045",
    VENDOR_NAME: "TechParts AG",
    WAERS: "EUR",
    NETWR: 12800.0,
    BEDAT: "20260312",
    FRGKE: "0",
    FRGZU: "",
    EKGRP: "002",
    EKORG: "1000",
    BUKRS: "1000",
    STATUS: "PENDING",
    releaseSteps: [
      { code: "A1", label: "Dept. Manager",    completed: false },
      { code: "B2", label: "Finance Director", completed: false }
    ],
    items: [
      { EBELP: "00010", TXZ01: "Control Unit CU-500", MENGE: 2, MEINS: "EA", NETPR: 6400.0, WERKS: "1000" }
    ]
  },
  {
    EBELN: "4500017816",
    LIFNR: "0000300012",
    VENDOR_NAME: "Global Logistics Ltd",
    WAERS: "USD",
    NETWR: 98750.0,
    BEDAT: "20260314",
    FRGKE: "0",
    FRGZU: "",
    EKGRP: "003",
    EKORG: "1000",
    BUKRS: "1000",
    STATUS: "PENDING",
    releaseSteps: [
      { code: "A1", label: "Dept. Manager",    completed: false },
      { code: "B2", label: "Finance Director", completed: false },
      { code: "C3", label: "VP Procurement",   completed: false }
    ],
    items: [
      { EBELP: "00010", TXZ01: "Conveyor Belt System", MENGE: 1, MEINS: "EA", NETPR: 75000.0, WERKS: "2000" },
      { EBELP: "00020", TXZ01: "Installation Service", MENGE: 1, MEINS: "EA", NETPR: 23750.0, WERKS: "2000" }
    ]
  }
];

// Valid release codes per PO (mirrors SAP release strategy config)
const mockReleaseCodes = {
  "4500017814": ["A1"],
  "4500017815": ["A1", "B2"],
  "4500017816": ["A1", "B2", "C3"]
};

module.exports = { mockPOs, mockReleaseCodes };
