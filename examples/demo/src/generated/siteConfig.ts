import type { KinloomSiteConfig } from '@kinloom/core';

export const demoSiteConfig: KinloomSiteConfig = {
  "site": {
    "title": "Lincoln & Todd Historical Archive",
    "familyName": "Lincoln & Todd Family",
    "gedcomSourceName": "LINCOLN_TODD_DEMO",
    "description": "Public-domain 18th and 19th-century historical demo archive tracing the Lincoln and Todd lines from Virginia and Kentucky through Indiana, Illinois, Washington, D.C., and Vermont.",
    "footerCredit": "Built with Kinloom"
  },
  "theme": {
    "accent": "#7A4612"
  },
  "defaultBranchId": "lincoln_hanks",
  "branches": [
    {
      "id": "lincoln_hanks",
      "label": "Lincoln & Hanks Line",
      "description": "Virginia, Kentucky, Indiana, and Illinois lineage of Thomas Lincoln and Abraham Lincoln.",
      "surnames": [
        "Lincoln",
        "Hanks",
        "Johnston",
        "Grigsby"
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
      "id": "todd_edwards",
      "label": "Todd & Edwards Line",
      "description": "Lexington, Kentucky and Springfield, Illinois lineage of Levi Todd, Robert Smith Todd, and Mary Ann Todd.",
      "surnames": [
        "Todd",
        "Edwards",
        "Parker",
        "Harlan",
        "Briggs"
      ],
      "lineageGroups": [
        "descendant_spouse",
        "extended"
      ],
      "supportsDirectMode": true
    }
  ],
  "lineageSections": [
    {
      "id": "pivot_and_descendants",
      "title": "Springfield & Washington Line (KY → IL → DC)",
      "lineageGroups": [
        "pivot_ancestor",
        "descendant"
      ]
    },
    {
      "id": "ancestors",
      "title": "Virginia, Kentucky & Indiana Ancestors",
      "lineageGroups": [
        "ancestor"
      ]
    },
    {
      "id": "allied",
      "title": "Siblings, Spouses & Allied Lines",
      "lineageGroups": [
        "colonial_sibling",
        "descendant_spouse",
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
      "note": "Grandfather and grandson sharing Virginia and Kentucky roots."
    },
    {
      "fromId": "p_abraham_lincoln_1809",
      "toId": "p_mary_todd_lincoln",
      "label": "Abraham Lincoln ↔ Mary Ann Todd",
      "note": "Married in Springfield, Illinois in November 1842."
    },
    {
      "fromId": "p_thomas_lincoln",
      "toId": "p_robert_todd_lincoln",
      "label": "Thomas Lincoln ↔ Robert Todd Lincoln",
      "note": "Grandfather and eldest surviving grandson."
    },
    {
      "fromId": "p_levi_todd",
      "toId": "p_robert_todd_lincoln",
      "label": "Levi Todd ↔ Robert Todd Lincoln",
      "note": "Maternal great-grandfather from Lexington, Kentucky."
    }
  ],
  "migrationEras": [
    {
      "id": "appalachian_east",
      "label": "East & Capital",
      "description": "Virginia, Washington, D.C., and Vermont communities.",
      "color": "#1B2A41",
      "minLng": -82
    },
    {
      "id": "ohio_valley",
      "label": "Kentucky & Indiana",
      "description": "Hardin County, Lexington, and Spencer County settlements.",
      "color": "#2F5245",
      "minLng": -88,
      "maxLng": -82
    },
    {
      "id": "prairie_west",
      "label": "Illinois Prairie",
      "description": "New Salem and Springfield, Sangamon County, Illinois.",
      "color": "#7A4612",
      "maxLng": -88
    }
  ],
  "mapDefaults": {
    "centerLat": 39.2,
    "centerLng": -83.5,
    "zoom": 5,
    "minSpanDeg": 1.5
  },
  "anchorYears": [
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
  }
};
