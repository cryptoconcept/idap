// Vendored verbatim from scholarship-hub/packages/shared/src/enums.ts and
// .../data/states.ts and .../data/districts.karnataka.ts on 2026-09-06. IDAP cannot import the Hub package; this
// is the single source IDAP validates and maps against. Re-vendor (and update
// tests/fixtures/hub-vocabulary.json in the same commit) whenever the Hub's
// vocabulary changes — the drift test below fails until both agree.
export const HUB_SCHOLARSHIP_CATEGORIES = ['government','private','university','merit','need_based','girl_students','stem','minority_community','disability','sports','international','csr'] as const;
export const HUB_EDUCATION_LEVELS = ['school','puc','diploma','undergraduate','postgraduate','phd','other'] as const;
export const HUB_GENDERS = ['female','male','other'] as const;
export const HUB_COMMUNITY_CATEGORIES = ['general','sc','st','obc','category_1','2a','2b','3a','3b','minority','ews'] as const;
export const HUB_QUESTION_TYPES = ['text','textarea','select','radio','checkbox','date','number','file'] as const;
export const HUB_APPLICATION_MODES = ['platform','external'] as const;
export const HUB_STATE_CODES = ['AP','AR','AS','BR','CT','GA','GJ','HR','HP','JH','KA','KL','MP','MH','MN','ML','MZ','NL','OR','PB','RJ','SK','TN','TG','TR','UP','UT','WB','AN','CH','DN','DL','JK','LA','LD','PY'] as const;
// Karnataka launch market. Vendor the KA district codes verbatim from the Hub's
// districts data file (scholarship-hub/packages/shared/src/data/districts.karnataka.ts —
// all 31 districts in file order)
export const HUB_KA_DISTRICT_CODES = ['KA-BAG','KA-BLL','KA-BEL','KA-BLR','KA-BLU','KA-BID','KA-CHN','KA-CKB','KA-CKM','KA-CTD','KA-DKK','KA-DVG','KA-DHA','KA-GDG','KA-HAS','KA-HAV','KA-KLB','KA-KOD','KA-KOL','KA-KPL','KA-MAN','KA-MYS','KA-RAI','KA-RMN','KA-SHI','KA-TUM','KA-UDP','KA-UTK','KA-VJN','KA-VJP','KA-YAD'] as const;
