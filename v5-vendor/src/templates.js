function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderList(items = [], className = "list") {
  return `
    <ul class="${className}">
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function renderTable(rows = []) {
  return `
    <div class="spec-table">
      ${rows
        .map(
          ([label, value]) => `
            <div class="spec-row">
              <div class="spec-key">${escapeHtml(label)}</div>
              <div class="spec-value">${escapeHtml(value)}</div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderImageBlock(block) {
  const className = block.className ? ` ${escapeHtml(block.className)}` : "";
  return `
    <figure class="content-figure${className}">
      <img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || "")}" />
    </figure>
  `;
}

function renderBadgeRow(block) {
  return `
    <div class="badge-row">
      ${block.items
        .map(
          (item) => `
            <img class="badge-row-item" src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt || "")}" />
          `,
        )
        .join("")}
    </div>
  `;
}

function renderQrRow(block) {
  return `
    <div class="qr-block">
      <img class="qr-block-code" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || "QR code")}" />
      ${
        block.caption
          ? `<div class="qr-block-caption">${escapeHtml(block.caption)}</div>`
          : ""
      }
    </div>
  `;
}

function assetPath(fileName) {
  return `./assets/source/${encodeURI(fileName)}`;
}

function compactFrequencyValue(value = "") {
  const match = String(value).match(/([\d.,]+)\s*MHz\s*[~–-]\s*([\d.,]+)\s*MHz/i);
  if (match) {
    return `${match[1]}–${match[2]} MHz`;
  }
  return escapeHtml(value);
}

function highlightPhrase(text = "", phrase = "") {
  const safeText = escapeHtml(text);
  if (!phrase) {
    return safeText;
  }

  const safePhrase = escapeHtml(phrase);
  return safeText.includes(safePhrase)
    ? safeText.replace(safePhrase, `<strong>${safePhrase}</strong>`)
    : safeText;
}

function renderInlineStrong(text = "") {
  return escapeHtml(text).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

function renderPremiumCover(meta, page, pageNumber) {
  const config = page.coverConfig || {};
  const languageList = Array.isArray(config.languages)
    ? config.languages.join(" · ")
    : meta.language;
  const loconLogo = assetPath("LOCON logo.svg");
  const watchOutline = assetPath("smartwatch outline SVG.svg");

  return pageFrame({
    meta,
    page,
    pageNumber,
    extraClass: "page-cover",
    tone: "cover-clean",
    showHeader: false,
    showFooter: false,
    innerHtml: `
      <div class="cover-premium">
        <div class="cover-top-row">
          <div class="chip-group">
            <div class="chip">${escapeHtml(meta.device)}</div>
            ${
              page.coverConfig?.hideLanguageChip
                ? ""
                : `<div class="chip chip-language">${escapeHtml(page.languageLabel || meta.languageLabel || meta.language)}</div>`
            }
          </div>
        </div>

        <div class="cover-brand-lockup" aria-label="Brand lockup">
          <img class="cover-brand-logo cover-brand-logo-locon" src="${loconLogo}" alt="LOCON" />
          <span class="cover-brand-divider" aria-hidden="true"></span>
          <div class="cover-brand-safe-family" aria-label="Safe Family">
            <svg class="cover-brand-safe-family-icon" viewBox="0 0 18 17" role="presentation" aria-hidden="true">
              <path fill="#181818" fill-rule="evenodd" d="M8.06,1.1c-.82,1.02-1.31,2.35-1.31,3.88,0,1.33.64,2.62,1.6,3.89.92,1.22,2.22,2.53,3.79,3.97l-3.24,3.24c-2.8-2.31-5.39-4.79-7.54-7.57-1.72-2.24-1.91-4.94,0-6.86l.11-.11C3.03-.02,5.8-.76,8.06,1.1Z"/>
              <path fill="#5791cd" fill-rule="evenodd" d="M8,5C8,2,10.23,0,12.98,0s4.97,2,4.97,5c0,2-1.81,4.12-4.91,7.1-3.15-2.92-5.04-5.1-5.04-7.1ZM13,6.06c.83,0,1.51-.68,1.51-1.51s-.68-1.51-1.51-1.51-1.51.68-1.51,1.51.68,1.51,1.51,1.51Z"/>
            </svg>
            <span class="cover-brand-safe-family-text">
              <span>Safe</span>
              <span>Family</span>
            </span>
          </div>
        </div>

        <div class="cover-premium-body">
          <div class="cover-main">
            <div class="left-column">
              <div class="cover-premium-copy">
                <h1 class="cover-premium-title">
                  <span>${escapeHtml(config.titleLine1 || "Szybki start")}</span>
                  <span class="cover-premium-title-accent">${escapeHtml(config.titleLine2 || "i karta gwarancyjna")}</span>
                </h1>
                <p class="cover-premium-subtitle">${escapeHtml(config.subtitle || "Quick Start Guide & Warranty Card")}</p>

                <div class="cover-tech-block">
                  <div>${escapeHtml(config.productType || "Smartwatch")}</div>
                  <div>${escapeHtml(config.productName || "")}</div>
                  <div>${escapeHtml(config.model || "")}</div>
                  <div>${escapeHtml(config.version || "")}</div>
                </div>
              </div>
              <div class="cover-language-list">${escapeHtml(languageList)}</div>
            </div>

            <div class="right-column">
              <div class="cover-premium-visual" aria-hidden="true">
                <img class="cover-watch-outline" src="${watchOutline}" alt="" />
              </div>
            </div>
          </div>
        </div>

        <div class="cover-cover-footer">
          <div></div>
          <div class="folio">${String(page.displayNumber ?? pageNumber).padStart(2, "0")}</div>
        </div>
      </div>
    `,
  });
}

function renderClosingPage(meta, page, pageNumber) {
  const loconLogo = assetPath("LOCON logo.svg");

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    showPageTitle: false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card closing-page-card">
        <div class="closing-page">
          <div class="closing-brand-lockup" aria-label="Brand lockup">
            <div class="closing-brand-safe-family" aria-label="Safe Family">
              <svg class="closing-brand-safe-family-icon" viewBox="0 0 18 17" role="presentation" aria-hidden="true">
                <path fill="#181818" fill-rule="evenodd" d="M8.06,1.1c-.82,1.02-1.31,2.35-1.31,3.88,0,1.33.64,2.62,1.6,3.89.92,1.22,2.22,2.53,3.79,3.97l-3.24,3.24c-2.8-2.31-5.39-4.79-7.54-7.57-1.72-2.24-1.91-4.94,0-6.86l.11-.11C3.03-.02,5.8-.76,8.06,1.1Z"/>
                <path fill="#5791cd" fill-rule="evenodd" d="M8,5C8,2,10.23,0,12.98,0s4.97,2,4.97,5c0,2-1.81,4.12-4.91,7.1-3.15-2.92-5.04-5.1-5.04-7.1ZM13,6.06c.83,0,1.51-.68,1.51-1.51s-.68-1.51-1.51-1.51-1.51.68-1.51,1.51.68,1.51,1.51,1.51Z"/>
              </svg>
              <span class="closing-brand-safe-family-text">
                <span>Safe</span>
                <span>Family</span>
              </span>
            </div>
            <span class="closing-brand-divider" aria-hidden="true"></span>
            <img class="closing-brand-locon-logo" src="${loconLogo}" alt="LOCON" />
          </div>
        </div>
      </div>
    `,
  });
}

function pageFrame({
  meta,
  page,
  pageNumber,
  innerHtml,
  tone = "light",
  pageTitle = "",
  showFooter = true,
  showHeader = true,
  showPageTitle = true,
  extraClass = "",
  footerLabelOverride,
}) {
  const folioValue = page.displayNumber ?? pageNumber;
  const chipLabel = page.languageLabel || meta.language;
  const footerLabel =
    footerLabelOverride !== undefined
      ? footerLabelOverride
      : page.footerLabel || `${meta.language} · ${meta.revision}`;

  return `
    <section
      class="page tone-${tone} page-${escapeHtml(page.type)} ${escapeHtml(extraClass)}"
      data-page-number="${pageNumber}"
      data-page-label="${escapeHtml(page.label || "")}"
    >
      <div class="page-shell">
        ${
          showHeader
            ? `
              <header class="page-top">
                <div class="chip-group">
                  <div class="chip">${escapeHtml(meta.device)}</div>
                  <div class="chip chip-language">${escapeHtml(chipLabel)}</div>
                </div>
                ${
                  showPageTitle
                    ? `<div class="page-title">${escapeHtml(pageTitle || meta.title)}</div>`
                    : `<div class="page-title page-title-hidden"></div>`
                }
              </header>
            `
            : ""
        }
        <main class="page-body">
          ${innerHtml}
        </main>
        ${
          showFooter
            ? `
              <footer class="page-footer">
                <div>${escapeHtml(footerLabel)}</div>
                <div class="folio">${String(folioValue).padStart(2, "0")}</div>
              </footer>
            `
            : '<footer class="page-footer page-footer-empty"></footer>'
        }
      </div>
    </section>
  `;
}

function renderCover(meta, branding, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "dark",
    pageTitle: "Cover",
    innerHtml: `
      <div class="cover-grid">
        <div class="eyebrow">${escapeHtml(page.eyebrow)}</div>
        <div>
          <h1 class="cover-title">${escapeHtml(page.headline)}</h1>
          <p class="cover-subtitle">${escapeHtml(page.subheadline)}</p>
        </div>
        <div class="cover-panel">
          <div class="cover-panel-label">${escapeHtml(branding.company)}</div>
          <div class="cover-panel-title">${escapeHtml(meta.subtitle)}</div>
          <div class="cover-panel-copy">${escapeHtml(page.footerNote)}</div>
        </div>
      </div>
    `,
  });
}

function renderToc(meta, page, pageNumber, tocItems) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.title,
    innerHtml: `
      <div class="section-card">
        <h2>${escapeHtml(page.title)}</h2>
        <div class="toc-list">
          ${tocItems
            .map(
              (item) => `
                <div class="toc-row">
                  <div class="toc-name">${escapeHtml(item.label)}</div>
                  <div class="toc-dots"></div>
                  <div class="toc-page">${String(item.pageNumber).padStart(2, "0")}</div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `,
  });
}

function renderQr(meta, branding, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.title,
    innerHtml: `
      <div class="section-card">
        <h2>${escapeHtml(page.title)}</h2>
        <p class="lede">${escapeHtml(page.body)}</p>
        <div class="qr-layout">
          <div class="qr-placeholder" aria-label="QR code placeholder">
            <span>QR</span>
          </div>
          <div class="qr-meta">
            <div class="qr-label">${escapeHtml(branding.qrLabel)}</div>
            ${renderList(page.notes, "note-list")}
          </div>
        </div>
      </div>
    `,
  });
}

function renderStep(meta, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.label,
    innerHtml: `
      <div class="section-card">
        <div class="step-kicker">Step ${escapeHtml(page.stepNumber)}</div>
        <h2>${escapeHtml(page.title)}</h2>
        <p class="lede">${escapeHtml(page.body)}</p>
        ${renderList(page.bullets, "step-list")}
      </div>
    `,
  });
}

function renderWarning(meta, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "warn",
    pageTitle: page.label,
    innerHtml: `
      <div class="section-card warn-card">
        <div class="warning-badge">!</div>
        <h2>${escapeHtml(page.title)}</h2>
        ${renderList(page.warnings, "warning-list")}
      </div>
    `,
  });
}

function renderSpec(meta, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.label,
    innerHtml: `
      <div class="section-card">
        <h2>${escapeHtml(page.title)}</h2>
        ${renderTable(page.rows)}
      </div>
    `,
  });
}

function renderWarranty(meta, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.label,
    innerHtml: `
      <div class="section-card">
        <h2>${escapeHtml(page.title)}</h2>
        <p class="lede">${escapeHtml(page.body)}</p>
        <div class="warranty-fields">
          ${page.fields
            .map(
              (field) => `
                <div class="warranty-field">
                  <span>${escapeHtml(field)}</span>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `,
  });
}

function renderContactPage(meta, page, pageNumber) {
  const contact = page.contactPage || {};
  const title = contact.title || page.title || page.label || "";
  const subtitle =
    contact.subtitle || page.blocks?.find((block) => block.kind === "paragraph")?.text || "";
  const qrAsset = contact.qrAsset || "./assets/source/qr-full-manual.svg";
  const qrAlt = contact.qrAlt || "Kod QR";
  const question = contact.question || page.blocks?.[1]?.text || "";
  const phoneLabel = contact.phoneLabel || "Zadzwoń do nas:";
  const phone = contact.phone || page.blocks?.[2]?.text || "";
  const hoursHeading = contact.hoursHeading || "Godziny kontaktu";
  const hours = Array.isArray(contact.hours) ? contact.hours : [];
  const hasPhone = Boolean(phone);
  const hasHours = hours.length > 0;
  const hasDivider = hasPhone && hasHours;

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "contact",
    pageTitle: page.label || meta.title,
    extraClass: "page-contact",
    showPageTitle: false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card internal-card contact-card">
        <div class="contact-layout">
          <div class="contact-main">
            <div class="contact-left">
              <h2 class="contact-title">${escapeHtml(title)}</h2>
              <p class="contact-subtitle">${escapeHtml(subtitle)}</p>
              <div class="qr-code-slot">
                <img class="qr-code-image" src="${escapeHtml(qrAsset)}" alt="${escapeHtml(qrAlt)}" />
              </div>
            </div>

            <div class="contact-divider-vertical" aria-hidden="true"></div>

            <div class="contact-right">
              <div class="contact-question">${escapeHtml(question)}</div>
              ${
                hasPhone
                  ? `
                    <div class="contact-phone-label call-label">${escapeHtml(phoneLabel)}</div>
                    <div class="contact-phone">${escapeHtml(phone)}</div>
                  `
                  : ""
              }
              ${hasDivider ? '<div class="contact-divider" aria-hidden="true"></div>' : ""}
              ${
                hasHours
                  ? `
                    <div class="contact-hours-heading">${escapeHtml(hoursHeading)}</div>
                    <div class="hours-grid">
                      ${hours
                        .map(
                          (row) => `
                            <div class="contact-hours-row">
                              <div class="hours-label">${escapeHtml(row.label || "")}</div>
                              <div class="hours-value">${escapeHtml(row.value || "")}</div>
                            </div>
                          `,
                        )
                        .join("")}
                    </div>
                  `
                  : ""
              }
            </div>
          </div>
        </div>
      </div>
    `,
  });
}

function renderAppDownloadPage(meta, page, pageNumber) {
  const config = page.appDownloadPage || {};
  const stepNumber = config.stepNumber || "1";
  const instruction =
    config.instruction || page.blocks?.find((block) => block.kind === "paragraph")?.text || "";
  const instructionHtml = highlightPhrase(instruction, config.highlight || "");
  const googlePlayBadge = config.googlePlayBadge || "./assets/source/google-play-badge.svg";
  const appStoreBadge = config.appStoreBadge || "./assets/source/app-store-badge.svg";
  const qrAsset = config.qrAsset || "./assets/source/qr-code-pl.svg";
  const qrCaption =
    config.qrCaption || page.blocks?.[page.blocks.length - 1]?.text || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    extraClass: "page-app-download",
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card app-download-card">
        <div class="app-download-grid step-grid">
          <div class="app-download-left step-column">
            <div class="app-step-badge">${escapeHtml(stepNumber)}</div>
            <p class="app-download-copy">${instructionHtml}</p>
            <div class="app-badge-stack">
              <img class="app-store-badge" src="${escapeHtml(googlePlayBadge)}" alt="Google Play" />
              <img class="app-store-badge" src="${escapeHtml(appStoreBadge)}" alt="App Store" />
            </div>
          </div>

          <div class="app-download-divider step-divider" aria-hidden="true"></div>

          <div class="app-download-right step-column">
            <div class="app-step-badge">2</div>
            <p class="app-download-copy app-download-copy-right">${escapeHtml(qrCaption)}</p>
            <img class="app-download-qr" src="${escapeHtml(qrAsset)}" alt="Kod QR aplikacji" />
          </div>
        </div>
      </div>
    `,
  });
}

function renderStepDetailPage(meta, page, pageNumber) {
  const detail = page.stepDetail || {};
  const title = detail.title || "";
  const subtitle = detail.subtitle || "";
  const body = detail.body || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card step-detail-card">
        <div class="step-detail">
          <div class="step-detail-copy">
            <h2>${escapeHtml(title)}</h2>
            <p class="step-subtitle">${escapeHtml(subtitle)}</p>
            <p class="step-body">${escapeHtml(body)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderStepListDetailPage(meta, page, pageNumber) {
  const detail = page.stepListDetail || {};
  const title = detail.title || "";
  const subtitle = detail.subtitle || "";
  const steps = Array.isArray(detail.steps) ? detail.steps : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card step-list-detail-card">
        <div class="step-list-detail">
          <div class="step-detail-header">
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(subtitle)}</p>
          </div>

          <div class="vertical-steps">
            ${steps
              .map(
                (step, index) => `
                  <div class="vertical-step">
                    <div class="app-step-badge">${index + 1}</div>
                    <p>${escapeHtml(step)}</p>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
    `,
  });
}

function renderTechnicalOverviewPage(meta, page, pageNumber) {
  const config = page.technicalOverviewPage || {};
  const assets = config.assets || {};
  const frontFeatures = Array.isArray(config.frontFeatures) ? config.frontFeatures : [];
  const rearFeatures = Array.isArray(config.rearFeatures) ? config.rearFeatures : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card technical-overview-card device-overview-card">
        <div class="device-overview-grid">
          <div class="device-column device-column-left">
            <h2 class="device-section-title">${escapeHtml(config.frontTitle || "")}</h2>
            <div class="device-visual device-visual-front">
              <img class="device-illustration-front" src="${escapeHtml(assets.front || "")}" alt="Widok przodu zegarka" />
              <span class="device-marker device-marker-1" aria-hidden="true">1</span>
              <span class="device-marker device-marker-2" aria-hidden="true">2</span>
              <span class="device-marker device-marker-3" aria-hidden="true">3</span>
            </div>
            <div class="device-feature-group">
              ${frontFeatures
                .map(
                  (feature, index) => `
                    <div class="device-feature">
                      <p class="device-label"><span class="device-label-number">${index + 1}.</span>${escapeHtml(feature.label || "")}</p>
                      ${
                        Array.isArray(feature.details) && feature.details.length
                          ? `
                            <div class="device-feature-details">
                              ${feature.details
                                .map(
                                  (detail) =>
                                    `<p class="device-description">${escapeHtml(detail)}</p>`,
                                )
                                .join("")}
                            </div>
                          `
                          : ""
                      }
                    </div>
                  `,
                )
                .join("")}
            </div>
          </div>

          <div class="device-divider" aria-hidden="true"></div>

          <div class="device-column device-column-right">
            <h3 class="device-section-title">${escapeHtml(config.backTitle || "")}</h3>
            <div class="device-visual device-visual-rear">
              <div class="device-illustration-side-back">
                <img class="device-side-view watch-side-view" src="${escapeHtml(assets.side || "")}" alt="Widok boku zegarka" />
                <img class="device-back-view watch-back-view" src="${escapeHtml(assets.back || "")}" alt="Widok tyłu zegarka" />
              </div>
              <span class="device-marker device-marker-4" aria-hidden="true">4</span>
              <span class="device-marker device-marker-5" aria-hidden="true">5</span>
            </div>
            <div class="device-feature-group device-feature-group-compact">
              ${rearFeatures
                .map(
                  (feature, index) => `
                    <div class="device-feature">
                      <p class="device-label"><span class="device-label-number">${index + 4}.</span>${escapeHtml(feature.label || "")}</p>
                    </div>
                  `,
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>
    `,
  });
}

function renderChargingPage(meta, page, pageNumber) {
  const config = page.chargingPage || {};
  const title = config.title || "";
  const instruction = config.instruction || "";
  const image = config.image || "";
  const warning = config.warning || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card charging-step-card">
        <div class="charging-step">
          <p class="charging-instruction">${escapeHtml(instruction)}</p>

          <div class="charging-visual">
            <div class="charging-illustration-frame charging-illustration-frame-step-1">
              <img class="charging-illustration-image charging-illustration-image-step-1" src="${escapeHtml(image)}" alt="Widok ładowania zegarka" />
            </div>
          </div>

          <div class="charging-warning">
            <div class="charging-warning-icon">!</div>
            <p class="charging-warning-copy">${escapeHtml(warning)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderChargingUsbPage(meta, page, pageNumber) {
  const config = page.chargingUsbPage || {};
  const label = config.label || "";
  const title = config.title || "";
  const image = config.image || "";
  const warning = config.warning || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card charging-step-usb-card">
        <div class="charging-step-usb">
          <p class="charging-step-label">${escapeHtml(label)}</p>
          <h2 class="charging-step-title">${escapeHtml(title)}</h2>

          <div class="charging-step-visual">
            <div class="charging-illustration-frame charging-illustration-frame-step-2">
              <img class="charging-illustration-image charging-illustration-image-step-2" src="${escapeHtml(image)}" alt="Widok końcówki kabla USB i ładowarki" />
            </div>
          </div>

          <div class="charging-step-warning">
            <div class="charging-step-warning-icon">!</div>
            <p class="charging-step-warning-text">${escapeHtml(warning)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderChargingWallPage(meta, page, pageNumber) {
  const config = page.chargingWallPage || {};
  const label = config.label || "";
  const title = config.title || "";
  const image = config.image || "";
  const warning = config.warning || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card charging-step-wall-card">
        <div class="charging-step-wall">
          <p class="charging-step-wall-label">${escapeHtml(label)}</p>
          <h2 class="charging-step-wall-title">${escapeHtml(title)}</h2>

          <div class="charging-step-wall-visual">
            <div class="charging-illustration-frame charging-illustration-frame-step-3">
              <img class="charging-illustration-image charging-illustration-image-step-3" src="${escapeHtml(image)}" alt="Widok ładowarki podłączanej do gniazda elektrycznego" />
            </div>
          </div>

          <div class="charging-step-wall-warning">
            <div class="charging-step-wall-warning-icon">!</div>
            <p class="charging-step-wall-warning-text">${escapeHtml(warning)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderPowerPage(meta, page, pageNumber) {
  const config = page.powerPage || {};
  const intro = config.intro || "";
  const image = config.image || "";
  const info = Array.isArray(config.info) ? config.info : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card power-page-card">
        <div class="power-page">
          <p class="power-page-intro">${escapeHtml(intro)}</p>

          <div class="power-page-visual">
            <div class="power-page-visual-frame">
              <img class="power-page-watch" src="${escapeHtml(image)}" alt="Widok przodu zegarka" />
              <span class="power-page-button-ring" aria-hidden="true"></span>
            </div>
          </div>

          <div class="power-page-info">
            <div class="power-page-info-icon">!</div>
            <div class="power-page-info-copy">
              ${info.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
            </div>
          </div>
        </div>
      </div>
    `,
  });
}

function renderSosPage(meta, page, pageNumber) {
  const config = page.sosPage || {};
  const steps = Array.isArray(config.steps) ? config.steps : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card sos-page-card">
        <div class="sos-page">
          ${steps
            .map(
              (step) => `
                <div class="sos-step">
                  <div class="sos-step-badge">${escapeHtml(step.number || "")}</div>
                  <div class="sos-step-copy">
                    <h4 class="sos-step-title sos-step-title-${escapeHtml(step.tone || "neutral")}">${escapeHtml(step.title || "")}</h4>
                    <p class="sos-step-body">${escapeHtml(step.body || "")}</p>
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `,
  });
}

function renderTipsPage(meta, page, pageNumber) {
  const config = page.tipsPage || {};
  const sections = Array.isArray(config.sections) ? config.sections : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card tips-page-card">
        <div class="tips-page">
          ${sections
            .map(
              (section) => `
                <div class="tip-section">
                  <div class="tip-section-icon">i</div>
                  <div class="tip-section-copy">
                    <h4 class="tip-section-title">${escapeHtml(section.title || "")}</h4>
                    ${(Array.isArray(section.body) ? section.body : [])
                      .map((line) => `<p class="tip-section-body">${escapeHtml(line)}</p>`)
                      .join("")}
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `,
  });
}

function renderCallPage(meta, page, pageNumber) {
  const config = page.callPage || {};
  const title = config.title || "";
  const body = Array.isArray(config.body) ? config.body : [];
  const steps = Array.isArray(config.steps) ? config.steps : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card call-page-card">
        <div class="call-page">
          <h2 class="call-page-title">${escapeHtml(title)}</h2>
          <div class="call-page-body">
            ${body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          </div>
          <ol class="call-page-steps">
            ${steps
              .map(
                (step, index) => `
                  <li class="call-page-step">
                    <span class="call-page-step-number">${index + 1}.</span>
                    <span class="call-page-step-text">${escapeHtml(step)}</span>
                  </li>
                `,
              )
              .join("")}
          </ol>
        </div>
      </div>
    `,
  });
}

function renderWarningsPage(meta, page, pageNumber) {
  const config = page.warningsPage || {};
  const title = config.title || "";
  const intro = config.intro || "";
  const items = Array.isArray(config.items) ? config.items : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card warnings-page-card">
        <div class="warnings-page">
          <h2 class="warnings-page-title">${escapeHtml(title)}</h2>
          <p class="warnings-page-intro">${escapeHtml(intro)}</p>
          <div class="warnings-page-list">
            ${items
              .map(
                (item) => `
                  <div class="warnings-page-row">
                    <span class="warnings-page-dot" aria-hidden="true"></span>
                    <p class="warnings-page-text">${escapeHtml(item)}</p>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
    `,
  });
}

function renderSafetyPage(meta, page, pageNumber) {
  const config = page.safetyPage || {};
  const items = Array.isArray(config.items) ? config.items : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card safety-page-card">
        <div class="safety-page">
          <div class="safety-page-list">
            ${items
              .map(
                (item) => `
                  <div class="safety-page-row">
                    <span class="safety-page-dot" aria-hidden="true"></span>
                    <p class="safety-page-text">${escapeHtml(item)}</p>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
    `,
  });
}

function renderSarPage(meta, page, pageNumber) {
  const config = page.sarPage || {};
  const paragraphs = Array.isArray(config.paragraphs) ? config.paragraphs : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card sar-page-card">
        <div class="sar-page">
          ${paragraphs.map((text) => `<p class="sar-page-text">${escapeHtml(text)}</p>`).join("")}
        </div>
      </div>
    `,
  });
}

function renderWeeePage(meta, page, pageNumber) {
  const config = page.weeePage || {};
  const image = config.image || "";
  const body = config.body || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card weee-page-card">
        <div class="weee-page">
          <div class="weee-page-icon">
            <img src="${escapeHtml(image)}" alt="Symbol przekreślonego kosza" />
          </div>
          <div class="weee-page-copy">
            <p>${renderInlineStrong(body)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderDisposalPage(meta, page, pageNumber) {
  const config = page.disposalPage || {};
  const paragraphs = Array.isArray(config.paragraphs) ? config.paragraphs : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card disposal-page-card">
        <div class="disposal-page">
          ${paragraphs.map((text) => `<p>${renderInlineStrong(text)}</p>`).join("")}
        </div>
      </div>
    `,
  });
}

function renderCePage(meta, page, pageNumber) {
  const config = page.cePage || {};
  const category = config.category || "";
  const product = config.product || "";
  const body = config.body || "";
  const url = config.url || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card ce-page-card">
        <div class="ce-page">
          <p class="ce-page-category">${escapeHtml(category)}</p>
          <p class="ce-page-product">${escapeHtml(product)}</p>
          <p class="ce-page-body">${escapeHtml(body).replace(/\n/g, "<br />")}</p>
          <p class="ce-page-url">${escapeHtml(url)}</p>
        </div>
      </div>
    `,
  });
}

function renderWarrantyIntroPage(meta, page, pageNumber) {
  const config = page.warrantyIntroPage || {};
  const rows = Array.isArray(config.rows) ? config.rows : [];
  const warning = config.warning || "";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card warranty-intro-page-card">
        <div class="warranty-intro-page">
          ${
            config.company || config.heading
              ? `
                <div class="warranty-heading-block">
                  ${config.company ? `<p class="warranty-heading-eyebrow">${escapeHtml(config.company)}</p>` : ""}
                  ${config.heading ? `<p class="warranty-heading-title">${escapeHtml(config.heading)}</p>` : ""}
                </div>
              `
              : ""
          }

          <div class="warranty-info-table">
            ${rows
              .map(
                (row) => `
                  <div class="warranty-info-row">
                    <div class="warranty-info-label">${escapeHtml(row.label || "")}</div>
                    <div class="warranty-info-value">${escapeHtml(row.value || "")}</div>
                  </div>
                `,
              )
              .join("")}
          </div>

          <div class="warranty-notice-row">
            <div class="warranty-notice-icon">!</div>
            <p class="warranty-notice-text">${escapeHtml(warning)}</p>
          </div>
        </div>
      </div>
    `,
  });
}

function renderWarrantyClaimsPage(meta, page, pageNumber) {
  const config = page.warrantyClaimsPage || {};
  const sections = Array.isArray(config.sections) ? config.sections : [];
  const qrAsset = config.qrAsset || assetPath("warranty_claim_qr.svg");
  const qrAlt = config.qrAlt || "Kod QR reklamacji";
  const qrSteps = Array.isArray(config.qrSteps) ? config.qrSteps : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card warranty-claims-page-card">
        <div class="warranty-claims-page">
          ${sections
            .map(
              (section) => `
                <section class="warranty-editorial-section">
                  ${section.title ? `<h3 class="warranty-section-title">${escapeHtml(section.title)}</h3>` : ""}
                  <ul class="warranty-section-list">
                    ${(Array.isArray(section.items) ? section.items : [])
                      .map(
                        (item) => `
                          <li class="warranty-section-item">
                            <span class="warranty-section-dot" aria-hidden="true"></span>
                            <span class="warranty-section-copy">${escapeHtml(item)}</span>
                          </li>
                        `,
                      )
                      .join("")}
                  </ul>
                </section>
              `,
            )
            .join("")}

          <section class="warranty-editorial-section warranty-editorial-section-qr">
            ${config.qrSectionTitle ? `<h3 class="warranty-section-title">${escapeHtml(config.qrSectionTitle)}</h3>` : ""}
            <div class="warranty-qr-steps">
              <div class="warranty-qr-block">
                <img src="${escapeHtml(qrAsset)}" alt="${escapeHtml(qrAlt)}" />
              </div>
              <ol class="warranty-steps-list">
                ${qrSteps
                  .map(
                    (step, index) => `
                      <li class="warranty-step-item">
                        <span class="warranty-step-number">${index + 1}.</span>
                        <span class="warranty-step-copy">${escapeHtml(step)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>
            </div>
          </section>
        </div>
      </div>
    `,
  });
}

function renderWarrantyExclusionsPage(meta, page, pageNumber) {
  const config = page.warrantyExclusionsPage || {};
  const exclusions = Array.isArray(config.exclusions) ? config.exclusions : [];
  const qrAsset = config.qrAsset || assetPath("warranty_full_document_qr.svg");
  const qrAlt = config.qrAlt || "Kod QR pełnej gwarancji";

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card warranty-exclusions-page-card">
        <div class="warranty-exclusions-page">
          <section class="warranty-editorial-section">
            ${config.exclusionsTitle ? `<h3 class="warranty-section-title">${escapeHtml(config.exclusionsTitle)}</h3>` : ""}
            <ul class="warranty-section-list">
              ${exclusions
                .map(
                  (item) => `
                    <li class="warranty-section-item">
                      <span class="warranty-section-dot" aria-hidden="true"></span>
                      <span class="warranty-section-copy">${escapeHtml(item)}</span>
                    </li>
                  `,
                )
                .join("")}
            </ul>
          </section>

          <section class="warranty-editorial-section warranty-editorial-section-qr">
            ${config.fullTitle ? `<h3 class="warranty-section-title">${escapeHtml(config.fullTitle)}</h3>` : ""}
            <div class="warranty-qr-copy-block">
              <div class="warranty-qr-block">
                <img src="${escapeHtml(qrAsset)}" alt="${escapeHtml(qrAlt)}" />
              </div>
              <p class="warranty-qr-copy">${escapeHtml(config.fullText || "")}</p>
            </div>
          </section>

          <section class="warranty-editorial-section warranty-editorial-section-legal">
            ${config.legalTitle ? `<h3 class="warranty-section-title">${escapeHtml(config.legalTitle)}</h3>` : ""}
            <p class="warranty-legal-copy">${escapeHtml(config.legalText || "")}</p>
          </section>
        </div>
      </div>
    `,
  });
}

function renderFrequencyPage(meta, page, pageNumber) {
  const config = page.frequencyPage || {};
  const title = config.title || "";
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const headers = Array.isArray(config.headers) && config.headers.length === 3
    ? config.headers
    : ["Pasmo", "Zakres częstotliwości", "Wartości"];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card frequency-page-card">
        <div class="frequency-page">
          ${title ? `<h2 class="frequency-page-title">${escapeHtml(title)}</h2>` : ""}
          <div class="frequency-table-shell">
            <table class="frequency-table">
              <thead>
                <tr>
                  <th>${escapeHtml(headers[0])}</th>
                  <th>${escapeHtml(headers[1])}</th>
                  <th>${escapeHtml(headers[2])}</th>
                </tr>
              </thead>
              <tbody>
                ${groups
                  .map((group) =>
                    (Array.isArray(group.rows) ? group.rows : [])
                      .map(
                        (row, index) => `
                          <tr>
                            ${
                              index === 0
                                ? `<td class="frequency-table-group" rowspan="${group.rows.length}">${escapeHtml(group.band || "")}</td>`
                                : ""
                            }
                            <td class="frequency-table-range">${escapeHtml(row.range || "")}</td>
                            <td class="frequency-table-values">
                              ${
                                row.single
                                  ? `<div class="freq-value"><div class="freq-line"><span class="freq-text">${escapeHtml(row.single || "")}</span></div></div>`
                                  : row.both
                                    ? `<div class="freq-value"><div class="freq-line"><span class="freq-arrow"><strong>↑↓</strong></span><span class="freq-text">${compactFrequencyValue(row.both || "")}</span></div></div>`
                                    : `<div class="freq-value">
                                        <div class="freq-line"><span class="freq-arrow"><strong>↑</strong></span><span class="freq-text">${compactFrequencyValue(row.uplink || "")}</span></div>
                                        <div class="freq-line"><span class="freq-arrow"><strong>↓</strong></span><span class="freq-text">${compactFrequencyValue(row.downlink || "")}</span></div>
                                      </div>`
                              }
                            </td>
                          </tr>
                        `,
                      )
                      .join(""),
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `,
  });
}

function renderSimpleSpecTablePage(meta, page, pageNumber) {
  const config = page.simpleSpecTablePage || {};
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const rows = Array.isArray(config.rows) ? config.rows : [];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card simple-spec-page-card">
        <div class="table-card table-card-two-col">
          <table>
            <thead>
              <tr>
                ${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                    <tr>
                      <td>${escapeHtml(row[0] || "")}</td>
                      <td>${escapeHtml(row[1] || "")}</td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `,
  });
}

function renderPowerTablePage(meta, page, pageNumber) {
  const config = page.powerTablePage || {};
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const headers = Array.isArray(config.headers) && config.headers.length === 3
    ? config.headers
    : ["Pasmo", "Moce nadawania", "Wartość"];

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card power-table-page-card">
        <div class="table-card table-card-three-col">
          <table>
            <thead>
              <tr>
                <th>${escapeHtml(headers[0])}</th>
                <th>${escapeHtml(headers[1])}</th>
                <th>${escapeHtml(headers[2])}</th>
              </tr>
            </thead>
            <tbody>
              ${groups
                .map((group) =>
                  (Array.isArray(group.rows) ? group.rows : [])
                    .map(
                      (row, index) => `
                        <tr>
                          ${
                            index === 0
                              ? `<td class="table-group-label" rowspan="${group.rows.length}">${escapeHtml(group.band || "")}</td>`
                              : ""
                          }
                          <td>${escapeHtml(row.power || "")}</td>
                          <td class="table-value-cell power-value">${escapeHtml(row.value || "")}</td>
                        </tr>
                      `,
                    )
                    .join(""),
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `,
  });
}

function renderContent(meta, page, pageNumber) {
  const variantClass = page.variant ? ` card-variant-${escapeHtml(page.variant)}` : "";

  if (page.variant === "cover") {
    return renderPremiumCover(meta, page, pageNumber);
  }

  if (page.variant === "qr") {
    return renderContactPage(meta, page, pageNumber);
  }

  if (page.closingPage) {
    return renderClosingPage(meta, page, pageNumber);
  }

  if (page.appDownloadPage) {
    return renderAppDownloadPage(meta, page, pageNumber);
  }

  if (page.stepDetail) {
    return renderStepDetailPage(meta, page, pageNumber);
  }

  if (page.stepListDetail) {
    return renderStepListDetailPage(meta, page, pageNumber);
  }

  if (page.technicalOverviewPage) {
    return renderTechnicalOverviewPage(meta, page, pageNumber);
  }

  if (page.chargingPage) {
    return renderChargingPage(meta, page, pageNumber);
  }

  if (page.chargingUsbPage) {
    return renderChargingUsbPage(meta, page, pageNumber);
  }

  if (page.chargingWallPage) {
    return renderChargingWallPage(meta, page, pageNumber);
  }

  if (page.powerPage) {
    return renderPowerPage(meta, page, pageNumber);
  }

  if (page.sosPage) {
    return renderSosPage(meta, page, pageNumber);
  }

  if (page.tipsPage) {
    return renderTipsPage(meta, page, pageNumber);
  }

  if (page.callPage) {
    return renderCallPage(meta, page, pageNumber);
  }

  if (page.warningsPage) {
    return renderWarningsPage(meta, page, pageNumber);
  }

  if (page.safetyPage) {
    return renderSafetyPage(meta, page, pageNumber);
  }

  if (page.sarPage) {
    return renderSarPage(meta, page, pageNumber);
  }

  if (page.weeePage) {
    return renderWeeePage(meta, page, pageNumber);
  }

  if (page.disposalPage) {
    return renderDisposalPage(meta, page, pageNumber);
  }

  if (page.cePage) {
    return renderCePage(meta, page, pageNumber);
  }

  if (page.warrantyIntroPage) {
    return renderWarrantyIntroPage(meta, page, pageNumber);
  }

  if (page.warrantyClaimsPage) {
    return renderWarrantyClaimsPage(meta, page, pageNumber);
  }

  if (page.warrantyExclusionsPage) {
    return renderWarrantyExclusionsPage(meta, page, pageNumber);
  }

  if (page.frequencyPage) {
    return renderFrequencyPage(meta, page, pageNumber);
  }

  if (page.simpleSpecTablePage) {
    return renderSimpleSpecTablePage(meta, page, pageNumber);
  }

  if (page.powerTablePage) {
    return renderPowerTablePage(meta, page, pageNumber);
  }

  return pageFrame({
    meta,
    page,
    pageNumber,
    tone: page.variant === "warning" ? "warn" : "light",
    pageTitle: page.label || meta.title,
    showFooter: page.showFooter !== false,
    footerLabelOverride: "",
    innerHtml: `
      <div class="section-card content-card${variantClass}">
        ${page.titleOverride !== ""
          ? `<h2>${escapeHtml(page.titleOverride ?? page.title ?? page.label ?? "")}</h2>`
          : ""}
        <div class="content-flow">
          ${page.blocks
            .map((block) => {
              if (block.kind === "paragraph") {
                return `<p class="content-paragraph">${escapeHtml(block.text)}</p>`;
              }

              if (block.kind === "warning") {
                return `
                  <div class="content-warning-box">
                    <div class="warning-badge">!</div>
                    <p class="content-paragraph">${escapeHtml(block.text)}</p>
                  </div>
                `;
              }

              if (block.kind === "list") {
                return renderList(block.items, "content-list");
              }

              if (block.kind === "table") {
                return renderTable(block.rows);
              }

              if (block.kind === "image") {
                return renderImageBlock(block);
              }

              if (block.kind === "badges") {
                return renderBadgeRow(block);
              }

              if (block.kind === "qr") {
                return renderQrRow(block);
              }

              if (block.kind === "placeholder") {
                return `<div class="content-placeholder">${escapeHtml(block.text)}</div>`;
              }

              return "";
            })
            .join("")}
        </div>
      </div>
    `,
  });
}

function renderTocCustom(meta, page, pageNumber) {
  return pageFrame({
    meta,
    page,
    pageNumber,
    pageTitle: page.title,
    showFooter: page.showFooter !== false,
    innerHtml: `
      <div class="section-card">
        <h2>${escapeHtml(page.title)}</h2>
        <div class="toc-list">
          ${page.items
            .map(
              (item) => `
                <div class="toc-row">
                  <div class="toc-name">${escapeHtml(item.label)}</div>
                  <div class="toc-dots"></div>
                  <div class="toc-page">${String(item.pageNumber).padStart(2, "0")}</div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `,
  });
}

export function renderPage({ meta, branding, page, pageNumber, tocItems }) {
  switch (page.type) {
    case "cover":
      return renderCover(meta, branding, page, pageNumber);
    case "toc":
      return renderToc(meta, page, pageNumber, tocItems);
    case "qr":
      return renderQr(meta, branding, page, pageNumber);
    case "step":
      return renderStep(meta, page, pageNumber);
    case "warning":
      return renderWarning(meta, page, pageNumber);
    case "spec":
      return renderSpec(meta, page, pageNumber);
    case "warranty":
      return renderWarranty(meta, page, pageNumber);
    case "content":
      return renderContent(meta, page, pageNumber);
    case "toc-custom":
      return renderTocCustom(meta, page, pageNumber);
    default:
      throw new Error(`Unsupported page type: ${page.type}`);
  }
}
