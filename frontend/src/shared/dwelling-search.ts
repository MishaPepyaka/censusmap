export type DwellingSearchRecord = { code: string; cu: string; no: string };
export type DwellingSearchResult<T extends DwellingSearchRecord> = {
  record: T | null;
  records: T[];
  message: string;
  error: boolean;
};

export function createDwellingSearchIndex<T extends DwellingSearchRecord>() {
  const byCode = new Map<string, T[]>();
  const byCu = new Map<string, T[]>();
  const byNo = new Map<string, T[]>();
  const addTo = (index: Map<string, T[]>, key: string, record: T) => index.set(key, [...(index.get(key) || []), record]);
  return {
    add(record: T): void {
      addTo(byCode, record.code, record);
      addTo(byCu, record.cu, record);
      addTo(byNo, record.no, record);
    },
    clear(): void { byCode.clear(); byCu.clear(); byNo.clear(); },
    find(value: unknown, example = "462211020079"): DwellingSearchResult<T> {
      const digits = String(value || "").replace(/\D/g, "");
      if (!digits) return { record: null, records: [], message: `Enter code like ${example}`, error: true };
      let records: T[] = [];
      let message = "";
      if (digits.length >= 12) records = byCode.get(`${digits.slice(0, 8)}${digits.slice(-4)}`) || [];
      else if (digits.length === 8) {
        records = byCu.get(digits) || [];
        message = records.length ? `CU ${digits}: showing first dwelling` : `No dwellings in CU ${digits}`;
      } else if (digits.length <= 4) {
        const no = digits.padStart(4, "0");
        records = byNo.get(no) || [];
        message = records.length > 1 ? `Multiple ${no}, showing first match` : records.length ? "" : `No dwelling ${no}`;
      } else return { record: null, records: [], message: "Use 4, 8, or 12+ digits", error: true };
      if (!records.length) return { record: null, records, message: message || `Not found: ${digits}`, error: true };
      return { record: records[0], records, message, error: false };
    }
  };
}
