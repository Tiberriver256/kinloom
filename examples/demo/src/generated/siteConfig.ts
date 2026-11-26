import type { KinloomSiteConfig } from '@kinloom/core';

export const demoSiteConfig: KinloomSiteConfig = {
  "schemaVersion": 1,
  "site": {
    "title": "Lincoln & Todd Historical Archive",
    "familyName": "Lincoln & Todd Family",
    "gedcomSourceName": "LINCOLN_TODD_DEMO",
    "description": "Public-domain ten-generation historical archive (1622–1985) tracing the Lincoln, Hanks, Todd, and Harlan branches from Hingham, Norfolk and County Longford across Massachusetts, New Jersey, Pennsylvania, Virginia, Kentucky, Indiana, Illinois, Iowa, Washington, D.C., and Vermont with primary NARA and Library of Congress records.",
    "footerCredit": "Built with Kinloom"
  },
  "theme": {
    "accent": "#7A4612"
  },
  "defaultBranchId": "lincoln",
  "branches": [
    {
      "id": "lincoln",
      "label": "Lincoln Line (1622–1985)",
      "description": "Ten generations from Samuel Lincoln of Hingham, Norfolk (1622) through Massachusetts, New Jersey, Pennsylvania, Virginia, Kentucky, Indiana, Illinois, Washington, D.C., and Vermont.",
      "surnames": [
        "Lincoln",
        "Lyford",
        "Jones",
        "Salter",
        "Morris",
        "Herring",
        "Grigsby",
        "Isham",
        "Beckwith"
      ],
      "lineageGroups": [
        "ancestor",
        "pivot_ancestor",
        "descendant",
        "colonial_sibling"
      ],
      "supportsDirectMode": true
    },
    {
      "id": "hanks",
      "label": "Hanks & Johnston Line",
      "description": "Virginia, Kentucky, Indiana, and Illinois maternal and blended-family kin of Nancy Hanks, Lucy Hanks, Sarah Bush Johnston, Dennis Friend Hanks, and John Hanks.",
      "surnames": [
        "Hanks",
        "Lee",
        "Johnston"
      ],
      "lineageGroups": [
        "ancestor",
        "descendant_spouse",
        "extended"
      ],
      "supportsDirectMode": true
    },
    {
      "id": "todd_edwards",
      "label": "Todd & Edwards Line",
      "description": "County Longford, Pennsylvania, Lexington, and Springfield lineage of David Todd, Maj. Gen. Levi Todd, Robert Smith Todd, Mary Ann Todd, Elizabeth Todd Edwards, and Emilie Todd Helm.",
      "surnames": [
        "Todd",
        "Owen",
        "Briggs",
        "Parker",
        "Humphreys",
        "Edwards",
        "Wallace",
        "Helm"
      ],
      "lineageGroups": [
        "ancestor",
        "descendant_spouse",
        "colonial_sibling",
        "extended"
      ],
      "supportsDirectMode": true
    },
    {
      "id": "harlan",
      "label": "Harlan Line",
      "description": "Illinois, Iowa, Washington, D.C., and Vermont lineage of Silas Harlan, U.S. Senator and Secretary of the Interior James Harlan, Ann Eliza Peck, and Mary Eunice Harlan Lincoln.",
      "surnames": [
        "Harlan",
        "Conley",
        "Peck"
      ],
      "lineageGroups": [
        "ancestor",
        "descendant_spouse"
      ],
      "supportsDirectMode": true
    }
  ],
  "lineageSections": [
    {
      "id": "pivot_and_descendants",
      "title": "Springfield, Washington & Vermont Line (1809–1985)",
      "lineageGroups": [
        "pivot_ancestor",
        "descendant"
      ]
    },
    {
      "id": "ancestors",
      "title": "Colonial & Frontier Ancestors (1622–1899)",
      "lineageGroups": [
        "ancestor"
      ]
    },
    {
      "id": "spouses_and_siblings",
      "title": "Spouses & Collateral Siblings",
      "lineageGroups": [
        "descendant_spouse",
        "colonial_sibling"
      ]
    },
    {
      "id": "allied",
      "title": "Extended Hanks & Todd Kin",
      "lineageGroups": [
        "extended"
      ]
    }
  ],
  "featuredDocumentId": "src_lincoln_autobiography_1859",
  "featuredKinshipPairs": [
    {
      "fromId": "p_abraham_lincoln_1744",
      "toId": "p_abraham_lincoln_1809",
      "label": "Abraham Lincoln (1744) ↔ Abraham Lincoln (1809)",
      "note": "Grandfather and grandson sharing Rockingham County, Virginia and Kentucky frontier roots."
    },
    {
      "fromId": "p_abraham_lincoln_1809",
      "toId": "p_mary_todd_lincoln",
      "label": "Abraham Lincoln ↔ Mary Ann Todd",
      "note": "Married in Springfield, Illinois on November 4, 1842."
    },
    {
      "fromId": "p_samuel_lincoln_1622",
      "toId": "p_abraham_lincoln_1809",
      "label": "Samuel Lincoln (1622) ↔ Abraham Lincoln (1809)",
      "note": "Six generations from Hingham, Norfolk, England to Springfield, Illinois."
    },
    {
      "fromId": "p_abraham_lincoln_1809",
      "toId": "p_dennis_friend_hanks",
      "label": "Abraham Lincoln ↔ Dennis Friend Hanks",
      "note": "Maternal Hanks cousins raised together in Kentucky and Little Pigeon Creek, Indiana."
    },
    {
      "fromId": "p_abraham_lincoln_1809",
      "toId": "p_james_harlan",
      "label": "Abraham Lincoln ↔ Senator James Harlan",
      "note": "Cabinet colleagues whose children Robert Todd Lincoln and Mary Eunice Harlan married in 1868."
    },
    {
      "fromId": "p_samuel_lincoln_1622",
      "toId": "p_jessie_harlan_lincoln",
      "label": "Samuel Lincoln (1622) ↔ Jessie Harlan Lincoln (1875)",
      "note": "Eight generations spanning colonial Norfolk to Manchester, Vermont."
    }
  ],
  "migrationEras": [
    {
      "id": "british_isles",
      "label": "British Isles Origins",
      "description": "Hingham, Norfolk, England and County Longford, Ireland (1622–1737).",
      "color": "#3B4D61",
      "minLng": -15
    },
    {
      "id": "colonial_seaboard",
      "label": "Colonial Seaboard",
      "description": "Hingham and Scituate, Massachusetts; Monmouth County, New Jersey; Berks and Chester Counties, Pennsylvania (1637–1785).",
      "color": "#1B2A41",
      "minLng": -77.8,
      "maxLng": -68,
      "endYear": 1785
    },
    {
      "id": "appalachian_frontier",
      "label": "Appalachian & Kentucky Frontier",
      "description": "Rockingham and Hampshire Counties, Virginia; Jefferson, Washington, Hardin, and Fayette Counties, Kentucky; Spencer County, Indiana (1768–1855).",
      "color": "#2F5245",
      "minLng": -87.8,
      "maxLng": -77.8,
      "endYear": 1855
    },
    {
      "id": "midwest_prairie",
      "label": "Illinois Prairie & Midwest",
      "description": "New Salem, Springfield, Macon and Coles Counties, Illinois; Chicago; and Mount Pleasant, Iowa (1816–1899).",
      "color": "#7A4612",
      "maxLng": -87.8
    },
    {
      "id": "capital_and_new_england",
      "label": "Washington & New England",
      "description": "Washington, D.C., Cambridge, Massachusetts, and Hildene in Manchester, Vermont (1856–1985).",
      "color": "#5B3A5E",
      "minLng": -82,
      "maxLng": -68,
      "startYear": 1856
    }
  ],
  "mapDefaults": {
    "centerLat": 40.5,
    "centerLng": -78,
    "zoom": 4,
    "minSpanDeg": 1.5
  },
  "anchorYears": [
    {
      "year": 1637,
      "label": "1637"
    },
    {
      "year": 1686,
      "label": "1686"
    },
    {
      "year": 1733,
      "label": "1733"
    },
    {
      "year": 1782,
      "label": "1782"
    },
    {
      "year": 1809,
      "label": "1809"
    },
    {
      "year": 1820,
      "label": "1820"
    },
    {
      "year": 1835,
      "label": "1835"
    },
    {
      "year": 1850,
      "label": "1850"
    },
    {
      "year": 1860,
      "label": "1860"
    },
    {
      "year": 1865,
      "label": "1865"
    },
    {
      "year": 1880,
      "label": "1880"
    },
    {
      "year": 1905,
      "label": "1905"
    }
  ],
  "privacy": {
    "livingCutoffYears": 101,
    "referenceYear": 2026,
    "privateModeShowsBirthYear": true,
    "stripLivingPortraits": true,
    "stripLivingResidenceSpans": true,
    "markGedcomLivingConfidential": true
  },
  "pronunciations": {
    "Abraham": {
      "phonetic": "AY-bruh-ham",
      "ipa": "/ˈeɪ.bɹə.hæm/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Abraham",
      "source_label": "Wiktionary (English IPA)"
    },
    "Lincoln": {
      "phonetic": "LING-kun",
      "ipa": "/ˈlɪŋ.kən/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Lincoln",
      "source_label": "Wiktionary (English IPA)"
    },
    "Mary": {
      "phonetic": "MAIR-ee",
      "ipa": "/ˈmɛə.ɹi/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Mary",
      "source_label": "Wiktionary (English IPA)"
    },
    "Ann": {
      "phonetic": "AN",
      "ipa": "/æn/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Ann",
      "source_label": "Wiktionary (English IPA)"
    },
    "Todd": {
      "phonetic": "TAHD",
      "ipa": "/tɑd/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Todd",
      "source_label": "Wiktionary (English IPA)"
    },
    "Springfield, Illinois": {
      "phonetic": "SPRING-feeld",
      "ipa": "/ˈspɹɪŋ.fiːld/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Springfield",
      "source_label": "Wiktionary (English IPA)",
      "region": "Illinois"
    },
    "Hingham, England": {
      "phonetic": "HING-um",
      "ipa": "/ˈhɪŋ.əm/",
      "language": "en-GB",
      "source_url": "https://en.wiktionary.org/wiki/Hingham",
      "source_label": "Wiktionary (English IPA)",
      "region": "England"
    },
    "Hingham, Massachusetts": {
      "phonetic": "HING-um",
      "ipa": "/ˈhɪŋ.əm/",
      "language": "en-US",
      "source_url": "https://en.wiktionary.org/wiki/Hingham",
      "source_label": "Wiktionary (English IPA)",
      "region": "Massachusetts"
    }
  }
};
