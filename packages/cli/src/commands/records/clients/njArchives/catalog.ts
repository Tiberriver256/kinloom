export const DEFAULT_CACHE_TTL_HOURS = 168;
export const PORTAL_BASE = 'https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/';
export const PORTAL_INDEX = `${PORTAL_BASE}index.aspx`;
export const MONMOUTH_BASE = 'https://oprs.co.monmouth.nj.us/oprs/Archives/';
export const MONMOUTH_SEARCH = `${MONMOUTH_BASE}ASearch.aspx`;
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const PREFIX = 'ctl00$ContentPlaceHolder1$';
export const GRID_TARGET = 'ctl00$ContentPlaceHolder1$GridView1';
export const ALLOWED_HOSTS = ['wwwdnet-dos.nj.gov', 'oprs.co.monmouth.nj.us'] as const;
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

export interface NjDatabaseSpec {
  readonly title: string;
  readonly page: string;
  readonly target: string;
  readonly count: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly roles?: readonly string[];
  readonly notes?: string;
}

export interface NjGridLink {
  readonly text: string;
  readonly href: string;
}

export interface NjGridRow {
  readonly links: readonly NjGridLink[];
  readonly [column: string]: string | readonly NjGridLink[];
}

export interface NjSearchResult {
  readonly database: string;
  readonly title?: string | undefined;
  readonly headers: readonly string[];
  readonly rows: readonly NjGridRow[];
  readonly capped_500?: boolean;
  readonly pages_read: number;
  readonly cache_hit?: boolean;
}

export interface NjDatabaseEntry {
  readonly key: string;
  readonly title: string;
  readonly count: string;
}

export interface NjSearchCriteria {
  readonly surname?: string | null;
  readonly given?: string | null;
  readonly spouse_surname?: string | null;
  readonly spouse_given?: string | null;
  readonly county?: string | null | undefined;
  readonly location?: string | null;
  readonly from_year?: string | null;
  readonly to_year?: string | null;
  readonly role?: string | null;
  readonly case_type?: string | null;
  readonly case_number?: string | null;
  readonly keyword?: string | null;
}

export const DATABASES: Readonly<Record<string, NjDatabaseSpec>> = {
  land: {
    title: 'Early Land Records, ca. 1650-1900s',
    page: 'EarlyLandRecords.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl02$lbtnColonialMarriages',
    count: '75,685 land records, over 397,267 names (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      role: 'ddlToFrom',
      location: 'txtLocation',
      county: 'ddlCounty',
      from_year: 'EYear',
      to_year: 'LYear',
    },
    roles: ['Grantor', 'Grantee', 'Named', 'Official'],
    notes:
      'First stop for colonial New Jersey landholdings. Most deeds after 1785 were recorded at the county level, not the State. Result rows link to scanned PDFs.',
  },
  'supreme-court': {
    title: 'Supreme Court Case Files, 1704-1844',
    page: 'SupremeCourt.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl03$lbtnColonialMarriages',
    count: '55,114 case files, over 234,709 names (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      role: 'ddlRoleList',
      case_type: 'txtCaseType',
      county: 'ddlCountyList',
      from_year: 'EYear',
      to_year: 'LYear',
      case_number: 'txtCN',
    },
    roles: ['Plaintiff', 'Defendant', 'Official', 'Victim', 'Other'],
  },
  'colonial-marriages': {
    title: 'Colonial Marriage Bonds, ca. 1666-1799',
    page: 'ColonialMarriages.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl02$lbtnColonialMarriages',
    count: '11,533 marriage bonds',
    fields: {
      surname: 'txtGRLN',
      given: 'txtGRFN',
      spouse_surname: 'txtBRLN',
      spouse_given: 'txtBRFN',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
      location: 'ddlLocationList',
    },
  },
  'marriages-1848-1900': {
    title: 'Marriage Records, May 1848 - December 1900',
    page: 'Marriage1867.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl03$lbtnColonialMarriages',
    count: 'Approximately 492,000 marriage records',
    fields: {
      surname: 'txtGRLN',
      given: 'txtGRFN',
      spouse_surname: 'txtBRLN',
      spouse_given: 'txtBRFN',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
      county: 'ddlCountyList',
    },
  },
  'deaths-1848-1878': {
    title: 'Death Records, May 1848 - May 1878',
    page: 'DeathIndex1848.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl04$lbtnColonialMarriages',
    count: 'Over 303,172 death records (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      from_year: 'Year1',
      to_year: 'Year2',
      county: 'ddlCountyList',
    },
  },
  'deaths-1878-1900': {
    title: 'Death Records, June 1878 - December 1900',
    page: 'DeathIndex.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl05$lbtnColonialMarriages',
    count: '628,584 death records (data entry complete)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      from_year: 'Year1',
      to_year: 'Year2',
      county: 'ddlCountyList',
    },
  },
  'name-changes': {
    title: 'Legal Name Changes, 1847-1947',
    page: 'NameChanges.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl04$lbtnColonialMarriages',
    count: '12,254 name changes, 46,010 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'census-1885': {
    title: '1885 State Census - Passaic County and Atlantic City',
    page: 'Census1885.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl05$lbtnColonialMarriages',
    count: '69,302 names',
    fields: { surname: 'txtLN', given: 'txtFN', location: 'ddlLocation' },
  },
  'revwar-damage': {
    title: 'Revolutionary War Damage Claims, 1776-1783',
    page: 'RevWarDamages.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl02$lbtnColonialMarriages',
    count: '2,662 claims, 7,435 names',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      county: 'ddlCounty',
      location: 'ddlLocation',
      from_year: 'EYear',
      to_year: 'LYear',
    },
  },
  'civilwar-service': {
    title: 'Civil War Service Records, 1861-1865',
    page: 'StrykerCivilWar.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl03$lbtnColonialMarriages',
    count: '82,471 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'civilwar-vouchers': {
    title: 'Civil War Payment Vouchers, 1861-1865',
    page: 'CivilWarVouchers.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl04$lbtnColonialMarriages',
    count: '15,770 vouchers, 114,212 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'wwi-deaths': {
    title: 'World War I Deaths',
    page: 'WWICards.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl05$lbtnColonialMarriages',
    count: '3,427 names (9,310 scanned images)',
    fields: { surname: 'txtLN', given: 'txtFN', county: 'ddlNJCounty' },
  },
  'natguard-photos': {
    title: 'New Jersey National Guard Photographs',
    page: 'natguard1.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl06$lbtnColonialMarriages',
    count: '1,316 images',
    fields: {
      keyword: 'txtSearch',
      location: 'txtLocation',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
    },
  },
};

export const ORDER_ONLY: Readonly<Record<string, readonly [string, string, string, string]>> = {
  'births-1848-1925': [
    'Birth Record Search: May 1, 1848 - December 31, 1925',
    'BirthRecordsRequest.aspx',
    'GridView2',
    'ctl02',
  ],
  'marriages-1848-1950': [
    'Marriage Record Search: May 1, 1848 - December 31, 1950',
    'MarriageRecordsRequest.aspx',
    'GridView2',
    'ctl03',
  ],
  'deaths-1848-1950': [
    'Death Record Search: May 1, 1848 - December 31, 1950',
    'DeathRecordsRequest.aspx',
    'GridView2',
    'ctl04',
  ],
  'county-clerks-marriages': [
    "County Clerks' Marriage Record Search",
    'CountyMarriageRecordRequest.aspx',
    'GridView2',
    'ctl05',
  ],
  probate: ['Probate Record Search, ca. 1660-1952', 'ProbateRecordRequest.aspx', 'GridView4', 'ctl02'],
  naturalization: [
    'County Naturalization Record Search',
    'NaturalizationRecordRequest.aspx',
    'GridView4',
    'ctl03',
  ],
  'revwar-search': ['Revolutionary War Record Search', 'RevWarRecordRequest.aspx', 'GridView6', 'ctl02'],
  'wwi-search': ['World War I Record Search', 'WorldWarIRecordRequest.aspx', 'GridView6', 'ctl03'],
};

export const MARRIAGE_DATABASES = new Set<string>(['colonial-marriages', 'marriages-1848-1900']);
export const SUBMIT_BUTTON: Readonly<Record<string, string>> = { 'natguard-photos': 'btnSearch' };

export const DATABASE_ALIASES: Readonly<Record<string, string>> = {
  'colonial-marriage': 'colonial-marriages',
  'marriages-colonial': 'colonial-marriages',
  'marriage-colonial': 'colonial-marriages',
  'colonial-marriage-bonds': 'colonial-marriages',
  'marriage-bonds': 'colonial-marriages',
  marriages: 'marriages-1848-1900',
  marriage: 'marriages-1848-1900',
  'marriages-1848': 'marriages-1848-1900',
  deaths: 'deaths-1878-1900',
  'deaths-1848': 'deaths-1848-1878',
  'deaths-1878': 'deaths-1878-1900',
  'land-records': 'land',
  'early-land-records': 'land',
  deeds: 'land',
  supreme: 'supreme-court',
  court: 'supreme-court',
  'name-change': 'name-changes',
  census: 'census-1885',
  revwar: 'revwar-damage',
  'revwar-damages': 'revwar-damage',
  civilwar: 'civilwar-service',
  wwi: 'wwi-deaths',
  natguard: 'natguard-photos',
};

export const MONMOUTH_TOWNS = [
  'Atlantic',
  'Freehold',
  'Holmdel',
  'Howell',
  'Marlboro',
  'Middletown',
  'Ocean',
  'Shrewsbury',
  'Upper Freehold',
  'Wall',
] as const;

export const MONMOUTH_CATEGORIES = [
  'Agriculture',
  'Commerce',
  'Manufactures',
  'Mining',
  'Population',
  'Return of Births',
  'Return of Deaths',
] as const;
