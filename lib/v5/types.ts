import { z } from "zod";

/** Atrybucja: skąd pochodzi fakt. Każda wartość w KB ma źródło. */
export const ProvenanceSchema = z.object({
  source_doc: z.string().describe("Nazwa pliku źródłowego"),
  locator: z.string().optional().describe("Strona/arkusz/sekcja w źródle"),
  quote: z.string().optional().describe("Krótki cytat oryginału (dowód)"),
  confidence: z.enum(["high", "medium", "low"]).default("high"),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Wartość z atrybucją. */
export const factOf = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, sources: z.array(ProvenanceSchema).min(1) });

const S = () => factOf(z.string());
const N = () => factOf(z.number());

/** Pasmo radiowe z mocą max — wymóg RED art. 10(8a). */
export const RadioBandSchema = z.object({
  tech: z.string().describe("np. GSM 900, LTE B20, WiFi 2.4GHz, Bluetooth"),
  freq_mhz: z.string().optional().describe("zakres częstotliwości, np. 880–915 MHz"),
  max_power: z.string().describe("moc max z jednostką, np. 33 dBm / 2 W"),
  sources: z.array(ProvenanceSchema).min(1),
});

export const SarResultSchema = z.object({
  position: z.string().describe("np. limb/wrist 0mm, front-of-face 10mm, body"),
  band: z.string().optional(),
  value_w_kg: z.number(),
  limit_w_kg: z.number().optional().describe("2.0 głowa/twarz, 4.0 kończyny"),
  sources: z.array(ProvenanceSchema).min(1),
});

export const SafetyWarningSchema = z.object({
  severity: z.enum(["danger", "warning", "caution", "notice"]),
  topic: z.string().describe("np. bateria, ładowanie, zadławienie, pasek"),
  text_pl: z.string(),
  sources: z.array(ProvenanceSchema).min(1),
});

export const FeatureSchema = z.object({
  key: z.string().describe("stabilny identyfikator, np. sos_call, geofence"),
  name_pl: z.string(),
  description_pl: z.string(),
  how_to_pl: z.array(z.string()).optional().describe("kroki obsługi, jeśli znane"),
  requires_app: z.boolean().optional(),
  sources: z.array(ProvenanceSchema).min(1),
});

export const PairingStepSchema = z.object({
  n: z.number(),
  action_pl: z.string(),
  detail_pl: z.string().optional(),
  sources: z.array(ProvenanceSchema).min(1),
});

/** Kanoniczna baza wiedzy o urządzeniu — jedyne źródło prawdy dla kompozycji. */
export const DeviceKBSchema = z.object({
  identity: z.object({
    model_code: S().optional().describe("kod Locon, np. GJD.16"),
    trade_name: S().optional().describe("nazwa handlowa, np. Locon Watch Slay AI"),
    manufacturer_model: S().optional().describe("model producenta, np. Lagenio K9"),
    device_type: S().optional().describe("np. smartwatch dla dzieci z GPS"),
    manufacturer: factOf(
      z.object({ name: z.string(), address: z.string().optional() })
    ).optional(),
    importer: factOf(
      z.object({ name: z.string(), address: z.string().optional() })
    ).optional(),
  }),
  hardware: z.object({
    dimensions_mm: S().optional(),
    weight_g: N().optional(),
    display: S().optional(),
    battery: factOf(
      z.object({
        type: z.string().optional().describe("chemia, np. Li-Ion Polymer"),
        capacity_mah: z.number().optional(),
        removable: z.boolean().optional(),
        charging: z.string().optional().describe("np. magnetyczne, 5V/1A"),
        life: z.string().optional().describe("czas pracy, np. do 3 dni"),
      })
    ).optional(),
    ip_rating: S().optional(),
    sim: S().optional().describe("format SIM, np. nano-SIM"),
    sensors: z.array(S()).optional(),
    camera: S().optional(),
    memory: S().optional(),
    cpu: S().optional().describe("model procesora/chipsetu"),
    gps_chip: S().optional().describe("model odbiornika GNSS"),
    color: S().optional().describe("dostępne kolory obudowy"),
    strap: S().optional().describe("materiał paska i zapięcia"),
    buttons_ports_pl: z.array(S()).optional().describe("przyciski/porty i ich funkcje"),
  }),
  radio: z.object({
    bands: z.array(RadioBandSchema).default([]),
    positioning: S().optional().describe("GPS/GLONASS/Galileo/LBS/WiFi"),
  }),
  sar: z.object({
    results: z.array(SarResultSchema).default([]),
    standard: S().optional().describe("np. EN 50566, EN 62209-2"),
    lab: S().optional(),
  }),
  regulatory: z.object({
    red_nb: S().optional().describe("jednostka notyfikowana + nr certyfikatu"),
    rohs: S().optional(),
    reach: S().optional(),
    doc_url: S().optional().describe("URL pełnej deklaracji zgodności"),
    doc_signatory: S().optional(),
    standards: z.array(S()).optional().describe("normy z deklaracji zgodności"),
  }),
  features: z.array(FeatureSchema).default([]),
  app_flow: z.object({
    app_name: S().optional(),
    stores: z.array(S()).optional(),
    pairing_steps: z.array(PairingStepSchema).default([]),
  }),
  safety: z.array(SafetyWarningSchema).default([]),
  package_contents: z.array(S()).default([]),
  support: z.object({
    phone: S().optional(),
    email: S().optional(),
    www: S().optional(),
  }),
});
export type DeviceKB = z.infer<typeof DeviceKBSchema>;

/** Konflikt między źródłami — do rozstrzygnięcia przez człowieka lub regułę. */
export const KbConflictSchema = z.object({
  path: z.string().describe("ścieżka w KB, np. hardware.battery.capacity_mah"),
  values: z.array(
    z.object({ value: z.string(), source_doc: z.string(), locator: z.string().optional() })
  ),
  resolution: z.string().optional().describe("co wybrano i dlaczego"),
});
export type KbConflict = z.infer<typeof KbConflictSchema>;

export const KbReportSchema = z.object({
  conflicts: z.array(KbConflictSchema),
  gaps: z.array(z.string()).describe("ścieżki KB bez danych, istotne dla dokumentów"),
  coverage: z.array(
    z.object({ source_doc: z.string(), used: z.boolean(), why_unused: z.string().optional() })
  ),
});
export type KbReport = z.infer<typeof KbReportSchema>;

/** Rodzaje dokumentów źródłowych. */
export const SOURCE_KINDS = [
  "manufacturer_manual",
  "feature_guide",
  "tech_spec",
  "sar_report",
  "rf_test_report",
  "emc_test_report",
  "safety_test_report",
  "declaration_ce",
  "nb_certificate",
  "rohs_reach",
  "risk_assessment",
  "product_photos",
  "app_screens",
  "app_video",
  "protocol_spec",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Jak głęboko ekstrahować dany rodzaj (koszt vs wartość). */
export const KIND_DEPTH: Record<SourceKind, "full" | "targeted" | "skip"> = {
  manufacturer_manual: "full",
  feature_guide: "full",
  tech_spec: "full",
  sar_report: "targeted", // tylko wartości SAR + norma + lab (raport ma setki stron)
  rf_test_report: "targeted", // tylko pasma + moce max
  emc_test_report: "targeted", // tylko normy + wynik
  safety_test_report: "targeted",
  declaration_ce: "full",
  nb_certificate: "targeted",
  rohs_reach: "targeted",
  risk_assessment: "targeted",
  product_photos: "targeted",
  app_screens: "full",
  app_video: "full",
  protocol_spec: "skip", // protokół komunikacji serwerowej — bez wartości dla instrukcji
  other: "targeted",
};

export const ClassifyResultSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  language: z.string().describe("główny język dokumentu ISO 639-1, np. zh, en, pl"),
  device_hint: z.string().optional().describe("jakiego urządzenia dotyczy, jeśli widać"),
  summary_pl: z.string().describe("1-2 zdania po polsku: co to jest"),
});
export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;
