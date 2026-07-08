import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const bookletsDir = path.join(projectRoot, "data", "booklets");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceInline(text, target, replacement) {
  return String(text).replace(target, replacement);
}

function splitCeText(text = "") {
  const urlMatch = String(text).match(/https?:\/\/\S+$/);
  if (!urlMatch) {
    return { body: text, url: "" };
  }

  return {
    body: String(text).slice(0, urlMatch.index).trim(),
    url: urlMatch[0],
  };
}

const LOCALES = [
  {
    code: "BG",
    file: "gjd16-02-bg.json",
    tocGuide: "Кратко ръководство",
    tocWarranty: "Гаранционна карта",
    contactTitle: "QR + контакт",
    page4Title: "Стартирайте приложението",
    page4Subtitle: "Safe Family",
    page5Title: "Добавете устройство",
    page5Subtitle: "към приложението",
    tips: (source) => ({
      sections: [
        {
          title: source.blocks[0].text,
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: source.blocks[4].text,
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "Осъществяване на повикване",
      body: [
        "Изберете в меню „Телефон”.",
        "Натиснете върху избраното име на контакт, след това отново изберете „Телефон”.",
      ],
      steps: ["Отворете меню „Телефон“", "Изберете контакт", "Натиснете „Телефон“"],
    }),
    frequencyHeaders: ["Лента", "Честотен диапазон", "Стойности"],
    powerHeaders: ["Лента", "Мощности на предаване", "Стойност"],
    weeeHighlight: {
      phrase: "не трябва да се изхвърля с другите битови отпадъци",
      replacement: "**не трябва да се изхвърля с другите битови отпадъци**",
    },
    disposalHighlight: {
      phrase: "трябва да бъде отговорно сортиран и рециклиран",
      replacement: "**трябва да бъде отговорно сортиран и рециклиран**",
    },
  },
  {
    code: "HR",
    file: "gjd16-03-hr.json",
    tocGuide: "Brzi vodič",
    tocWarranty: "Jamstveni list",
    contactTitle: "QR + kontakt",
    page4Title: "Pokrenite aplikaciju",
    page4Subtitle: "Safe Family",
    page5Title: "Dodajte uređaj",
    page5Subtitle: "u aplikaciju",
    tips: (source) => ({
      sections: [
        {
          title: "Alarmni kontakt brojevi",
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: "SOS poziv",
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "Za uspostavljanje poziva",
      body: [
        "Odaberite u izborniku „Telefon”.",
        "Pritisnite na odabrano ime kontakta, zatim ponovno odaberite „Telefon”.",
      ],
      steps: ["Otvorite izbornik „Telefon“", "Odaberite kontakt", "Pritisnite „Telefon“"],
    }),
    frequencyHeaders: ["Pojas", "Raspon frekvencije", "Vrijednosti"],
    powerHeaders: ["Pojas", "Snaga odašiljanja", "Vrijednost"],
    weeeHighlight: {
      phrase: "ne smije odlagati s ostalim kućanskim otpadom",
      replacement: "**ne smije odlagati s ostalim kućanskim otpadom**",
    },
    disposalHighlight: {
      phrase: "potrebno ga je odgovorno sortirati i reciklirati",
      replacement: "**potrebno ga je odgovorno sortirati i reciklirati**",
    },
  },
  {
    code: "RO",
    file: "gjd16-04-ro.json",
    tocGuide: "Ghid rapid",
    tocWarranty: "Certificat de garanție",
    contactTitle: "QR + contact",
    page4Title: "Porniți aplicația",
    page4Subtitle: "Safe Family",
    page5Title: "Adăugați dispozitivul",
    page5Subtitle: "în aplicație",
    tips: (source) => ({
      sections: [
        {
          title: "Numere de contact pentru alarmă",
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: "Apel SOS",
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "Pentru a efectua un apel",
      body: [
        "Selectați în meniu „Telefon”.",
        "Apăsați pe numele contactului ales, apoi selectați din nou „Telefon”.",
      ],
      steps: ["Deschideți meniul „Telefon“", "Selectați contactul", "Apăsați „Telefon“"],
    }),
    frequencyHeaders: ["Bandă", "Interval de frecvență", "Valori"],
    powerHeaders: ["Bandă", "Puterea de transmisie", "Valoare"],
    weeeHighlight: {
      phrase: "nu se elimină împreună cu celelalte deșeuri menajere",
      replacement: "**nu se elimină împreună cu celelalte deșeuri menajere**",
    },
    disposalHighlight: {
      phrase: "trebuie sortat în mod responsabil și reciclat",
      replacement: "**trebuie sortat în mod responsabil și reciclat**",
    },
  },
  {
    code: "MK",
    file: "gjd16-05-mk.json",
    tocGuide: "Кратко упатство",
    tocWarranty: "Гарантна картичка",
    contactTitle: "QR + контакт",
    page4Title: "Стартувајте ја апликацијата",
    page4Subtitle: "Safe Family",
    page5Title: "Додајте уред",
    page5Subtitle: "во апликацијата",
    tips: (source) => ({
      sections: [
        {
          title: "Алармни контакт броеви",
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: "SOS повик",
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "За да воспоставите повик",
      body: [
        "Изберете во менито „Телефон”.",
        "Притиснете на избраното име на контакт, потоа повторно изберете „Телефон”.",
      ],
      steps: ["Отворете го менито „Телефон“", "Изберете контакт", "Притиснете „Телефон“"],
    }),
    frequencyHeaders: ["Опсег", "Фреквентен опсег", "Вредности"],
    powerHeaders: ["Опсег", "Моќност на предавање", "Вредност"],
    weeeHighlight: {
      phrase: "не смее да се отстранува со другите комунални отпадоци",
      replacement: "**не смее да се отстранува со другите комунални отпадоци**",
    },
    disposalHighlight: {
      phrase: "треба одговорно да се сортира и рециклира",
      replacement: "**треба одговорно да се сортира и рециклира**",
    },
  },
  {
    code: "SQ",
    file: "gjd16-06-sq.json",
    tocGuide: "Udhëzime të shkurtra",
    tocWarranty: "Karta e garancisë",
    contactTitle: "QR + kontakt",
    page4Title: "Nisni aplikacionin",
    page4Subtitle: "Safe Family",
    page5Title: "Shtoni pajisjen",
    page5Subtitle: "në aplikacion",
    tips: (source) => ({
      sections: [
        {
          title: "Numrat e kontaktit të alarmit",
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: "Thirrja SOS",
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "Për të kryer një thirrje",
      body: [
        "Zgjidhni në meny „Telefoni”.",
        "Shtypni mbi emrin e kontaktit të zgjedhur, pastaj përsëri zgjidhni „Telefoni”.",
      ],
      steps: ["Hapni menynë „Telefoni“", "Zgjidhni kontaktin", "Shtypni „Telefoni“"],
    }),
    frequencyHeaders: ["Brezi", "Gama e frekuencës", "Vlerat"],
    powerHeaders: ["Brezi", "Fuqia e transmetimit", "Vlera"],
    weeeHighlight: {
      phrase: "nuk duhet të hidhet bashkë me mbeturinat e tjera shtëpiake",
      replacement: "**nuk duhet të hidhet bashkë me mbeturinat e tjera shtëpiake**",
    },
    disposalHighlight: {
      phrase: "duhet të grupohet me përgjegjësi dhe të riciklohet",
      replacement: "**duhet të grupohet me përgjegjësi dhe të riciklohet**",
    },
  },
  {
    code: "EN",
    file: "gjd16-07-en.json",
    tocGuide: "Quick Start Guide",
    tocWarranty: "Warranty Card",
    contactTitle: "QR + contact",
    page4Title: "Launch the app",
    page4Subtitle: "Safe Family",
    page5Title: "Add the device",
    page5Subtitle: "to the application",
    tips: (source) => ({
      sections: [
        {
          title: "Emergency contact numbers",
          body: [source.blocks[1].text, source.blocks[2].text, source.blocks[3].text],
        },
        {
          title: "SOS call",
          body: [source.blocks[5].text],
        },
      ],
    }),
    callPage: () => ({
      title: "To make a call",
      body: [
        "Select “Phone” in the menu.",
        "Press on the selected contact name, then select “Phone” again.",
      ],
      steps: ["Open the “Phone” menu", "Select a contact", "Press “Phone”"],
    }),
    frequencyHeaders: ["Band", "Frequency range", "Values"],
    powerHeaders: ["Band", "Transmission power", "Value"],
    weeeHighlight: {
      phrase: "must not be disposed of together with other household waste",
      replacement: "**must not be disposed of together with other household waste**",
    },
    disposalHighlight: {
      phrase: "it should be responsibly sorted and recycled",
      replacement: "**it should be responsibly sorted and recycled**",
    },
  },
];

function buildLocalizedPages(pl, localized, locale) {
  const contentMap = new Map();
  for (const page of localized.pages) {
    if (typeof page.displayNumber === "number") contentMap.set(page.displayNumber, page);
  }

  const warrantyConditions = contentMap.get(30);
  const warrantyClaims = contentMap.get(31);
  const warrantyExclusions = contentMap.get(32);

  return pl.pages.slice(2).map((plPage) => {
    const displayNumber = plPage.displayNumber;
    const sourcePage =
      displayNumber === 29
        ? warrantyConditions
        : displayNumber === 30
          ? warrantyClaims
          : displayNumber === 31
            ? warrantyExclusions
            : contentMap.get(displayNumber);

    if (!sourcePage) throw new Error(`Missing ${localized.meta.language} source page for display number ${displayNumber}`);

    const page = clone(plPage);
    page.label = sourcePage.label;
    page.title = sourcePage.title;
    delete page.displayNumber;

    switch (displayNumber) {
      case 2:
        page.contactPage = {
          ...page.contactPage,
          title: locale.contactTitle,
          subtitle: sourcePage.blocks[0].text,
          question: sourcePage.blocks[1].text,
          phoneLabel: sourcePage.blocks[2].text.replace(/\s*help@locon\.pl\s*$/i, "").trim(),
          phone: "help@locon.pl",
          hoursHeading: "",
          hours: [],
        };
        break;
      case 3:
        page.appDownloadPage = {
          ...page.appDownloadPage,
          instruction: sourcePage.blocks[1].text,
          highlight: "Safe Family",
          qrCaption: sourcePage.blocks[3].text,
        };
        break;
      case 4:
        page.stepDetail = { ...page.stepDetail, title: locale.page4Title, subtitle: locale.page4Subtitle, body: sourcePage.blocks[1].text };
        break;
      case 5:
        page.stepListDetail = {
          ...page.stepListDetail,
          title: locale.page5Title,
          subtitle: locale.page5Subtitle,
          steps: sourcePage.blocks.slice(1).map((block) => block.text),
        };
        break;
      case 6:
        page.blocks = clone(sourcePage.blocks);
        break;
      case 7:
        page.technicalOverviewPage = {
          ...page.technicalOverviewPage,
          subtitle: sourcePage.blocks[0].text,
          frontTitle: sourcePage.blocks[1].text.toUpperCase(),
          backTitle: sourcePage.blocks[9].text.toUpperCase(),
          frontFeatures: [
            { label: sourcePage.blocks[2].text },
            { label: sourcePage.blocks[3].text, details: [sourcePage.blocks[4].text, sourcePage.blocks[5].text] },
            { label: sourcePage.blocks[6].text, details: [sourcePage.blocks[7].text, sourcePage.blocks[8].text] },
          ],
          rearFeatures: [{ label: sourcePage.blocks[10].text }, { label: sourcePage.blocks[11].text }],
        };
        break;
      case 8:
        page.chargingPage = { ...page.chargingPage, title: sourcePage.blocks[0].text, instruction: sourcePage.blocks[1].text, warning: sourcePage.blocks[2].text };
        break;
      case 9:
        page.chargingUsbPage = {
          ...page.chargingUsbPage,
          label: contentMap.get(8)?.blocks?.[0]?.text || page.chargingUsbPage.label,
          title: sourcePage.blocks[0].text,
          warning: sourcePage.blocks[1].text,
        };
        break;
      case 10:
        page.chargingWallPage = {
          ...page.chargingWallPage,
          label: contentMap.get(8)?.blocks?.[0]?.text || page.chargingWallPage.label,
          title: sourcePage.blocks[0].text,
          warning: sourcePage.blocks[1].text,
        };
        break;
      case 11:
        page.powerPage = { ...page.powerPage, intro: `${sourcePage.blocks[1].text} ${sourcePage.blocks[2].text}`.trim(), info: [sourcePage.blocks[3].text] };
        break;
      case 12:
        page.sosPage = {
          steps: [
            { number: "1", title: sourcePage.blocks[1].text, tone: "red", body: sourcePage.blocks[2].text },
            { number: "2", title: sourcePage.blocks[3].text, tone: "blue", body: sourcePage.blocks[4].text },
          ],
        };
        break;
      case 13:
        page.tipsPage = locale.tips(sourcePage);
        break;
      case 14:
        page.callPage = locale.callPage(sourcePage);
        break;
      case 15:
        page.warningsPage = { ...page.warningsPage, title: sourcePage.label, intro: sourcePage.blocks[1].text, items: clone(sourcePage.blocks[2].items) };
        break;
      case 16: {
        page.blocks = clone(plPage.blocks);
        const table = sourcePage.blocks.find((block) => block.kind === "table");
        page.blocks[0].text = sourcePage.blocks[0].text;
        page.blocks[1].rows = clone(table.rows);
        break;
      }
      case 17:
      case 18: {
        page.blocks = clone(plPage.blocks);
        const table = sourcePage.blocks.find((block) => block.kind === "table");
        const tableBlock = page.blocks.find((block) => block.kind === "table");
        tableBlock.rows = clone(table.rows);
        break;
      }
      case 19:
      case 20:
      case 21:
        page.frequencyPage = { ...page.frequencyPage, headers: locale.frequencyHeaders };
        break;
      case 22:
      case 23:
        page.powerTablePage = { ...page.powerTablePage, headers: locale.powerHeaders };
        break;
      case 24:
        page.safetyPage = { items: clone(sourcePage.blocks[1].items) };
        break;
      case 25:
        page.sarPage = { paragraphs: sourcePage.blocks.slice(1).map((block) => block.text) };
        break;
      case 26:
        page.weeePage = { ...page.weeePage, body: replaceInline(sourcePage.blocks[1].text, locale.weeeHighlight.phrase, locale.weeeHighlight.replacement) };
        break;
      case 27:
        page.disposalPage = {
          paragraphs: [replaceInline(sourcePage.blocks[1].text, locale.disposalHighlight.phrase, locale.disposalHighlight.replacement), sourcePage.blocks[2].text],
        };
        break;
      case 28: {
        const ce = splitCeText(sourcePage.blocks[2].text);
        page.cePage = {
          category: sourcePage.blocks[0].text,
          product: sourcePage.blocks[1].text.replace(" MODEL:", "\nMODEL:"),
          body: ce.body,
          url: ce.url,
        };
        break;
      }
      case 29:
        page.label = warrantyConditions.label;
        page.title = warrantyConditions.title;
        page.warrantyIntroPage = {
          company: "",
          heading: "",
          rows: [
            { label: warrantyConditions.blocks[2].text, value: warrantyConditions.blocks[3].text },
            { label: warrantyConditions.blocks[4].text, value: warrantyConditions.blocks[5].text },
            { label: warrantyConditions.blocks[6].text, value: warrantyConditions.blocks[7].text },
            { label: warrantyConditions.blocks[8].text, value: warrantyConditions.blocks[9].text },
          ],
          warning: warrantyConditions.blocks[10].text,
        };
        break;
      case 30:
        page.label = warrantyClaims.label;
        page.title = warrantyClaims.title;
        page.warrantyClaimsPage = {
          sections: [{ title: "", items: clone(warrantyClaims.blocks[1].items) }, { title: "", items: clone(warrantyClaims.blocks[3].items) }],
          qrSectionTitle: "",
          qrAsset: "./assets/source/warranty_claim_qr.svg",
          qrAlt: `${locale.code} warranty claim QR`,
          qrSteps: clone(warrantyClaims.blocks[5].items),
        };
        break;
      case 31:
        page.label = warrantyExclusions.label;
        page.title = warrantyExclusions.title;
        page.warrantyExclusionsPage = {
          exclusionsTitle: "",
          exclusions: clone(warrantyExclusions.blocks[1].items),
          fullTitle: "",
          fullText: warrantyExclusions.blocks[3].text,
          qrAsset: "./assets/source/warranty_full_document_qr.svg",
          qrAlt: `${locale.code} full warranty QR`,
          legalTitle: "",
          legalText: warrantyExclusions.blocks[5].text,
        };
        break;
    }

    return page;
  });
}

function withLanguageLabel(pages, languageCode, revision) {
  return pages.map((page) => ({
    ...page,
    languageLabel: languageCode,
    footerLabel: `${languageCode} · ${revision}`,
  }));
}

async function main() {
  const pl = JSON.parse(await fs.readFile(path.join(bookletsDir, "gjd16-01-pl.json"), "utf8"));

  const localizedBooklets = [];
  for (const locale of LOCALES) {
    const localized = JSON.parse(await fs.readFile(path.join(bookletsDir, locale.file), "utf8"));
    localizedBooklets.push({
      locale,
      booklet: localized,
      pages: withLanguageLabel(buildLocalizedPages(pl, localized, locale), locale.code, localized.meta.revision),
    });
  }

  const plContentPages = withLanguageLabel(clone(pl.pages.slice(2)), "PL", pl.meta.revision);

  let nextStart = 3;
  const tocItems = [
    { label: `PL · ${pl.toc.items[0].label}`, pageNumber: nextStart },
    { label: `PL · ${pl.toc.items[1].label}`, pageNumber: nextStart + 27 },
  ];
  nextStart += plContentPages.length;

  for (const entry of localizedBooklets) {
    tocItems.push({ label: `${entry.locale.code} · ${entry.locale.tocGuide}`, pageNumber: nextStart });
    tocItems.push({ label: `${entry.locale.code} · ${entry.locale.tocWarranty}`, pageNumber: nextStart + 27 });
    nextStart += entry.pages.length;
  }

  const combinedPages = [
    {
      ...clone(pl.pages[0]),
      coverConfig: {
        ...(clone(pl.pages[0]).coverConfig || {}),
        hideLanguageChip: true,
      },
    },
    {
      type: "toc-custom",
      title: "SPIS TREŚCI",
      label: "SPIS TREŚCI",
      showFooter: false,
      items: tocItems,
    },
    ...plContentPages,
    ...localizedBooklets.flatMap((entry) => entry.pages),
    {
      type: "content",
      label: "",
      title: "",
      variant: "closing",
      closingPage: true,
      languageLabel: "MULTI",
      footerLabel: "",
    },
  ].map((page, index) => {
    const next = clone(page);
    if (next.type !== "toc-custom") next.displayNumber = index + 1;
    else delete next.displayNumber;
    return next;
  });

  const combined = {
    meta: {
      ...clone(pl.meta),
      documentId: "gjd16-multilang-master",
      language: "MULTI",
      languageLabel: "PL/BG/HR/RO/MK/SQ/EN",
      revision: "PL + BG + HR + RO + MK + SQ + EN combined booklet",
    },
    branding: clone(pl.branding),
    toc: {
      title: "SPIS TREŚCI",
      items: tocItems,
    },
    pages: combinedPages,
  };

  const outputFile = path.join(bookletsDir, "gjd16-multilang-master.json");
  await fs.writeFile(outputFile, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
  console.log(`Generated JSON: ${outputFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
