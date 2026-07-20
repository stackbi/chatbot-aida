/**
 * Widget IA Aïda — Overlay Popup Premium avec Liquid Glass.
 *
 * Au clic sur le bouton flottant, un overlay plein écran s'ouvre
 * avec un effet de verre liquide translucide. Responsive :
 * - Desktop : popup centré avec fond semi-transparent
 * - Mobile : plein écran
 */
(function () {
  const currentScript =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  const scriptUrl = new URL(currentScript.src);
  const BACKEND_ORIGIN = scriptUrl.origin;

  if (window.__aidaWidgetLoaded) return;
  window.__aidaWidgetLoaded = true;

  const ACCENT = currentScript.getAttribute("data-accent-color") || "#2f6fed";
  const ACCENT_DARK = currentScript.getAttribute("data-accent-color-dark") || "#1a4fad";
  const POSITION = currentScript.getAttribute("data-position") || "right";

  // ─── Styles ──────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --aida-accent: ${ACCENT};
      --aida-accent-dark: ${ACCENT_DARK};
      --aida-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    /* --- BOUTON LAUNCHER (inchangé) --- */
    #aida-launcher {
      position: fixed; bottom: 24px; ${POSITION}: 24px;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, var(--aida-accent), var(--aida-accent-dark));
      border: none; box-shadow: 0 6px 20px rgba(0,0,0,0.15);
      cursor: pointer; z-index: 2147483000;
      transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease;
    }
    #aida-launcher::before {
      content: ""; position: absolute; inset: -4px; border-radius: 50%;
      background: var(--aida-accent); opacity: 0.25;
      animation: aida-pulse-ring 2.5s ease-out infinite;
    }
    @keyframes aida-pulse-ring {
      0% { transform: scale(1); opacity: 0.3; }
      50% { transform: scale(1.2); opacity: 0.08; }
      100% { transform: scale(1); opacity: 0.3; }
    }
    #aida-launcher:hover { transform: scale(1.08); box-shadow: 0 8px 28px rgba(0,0,0,0.25), 0 0 20px rgb(47 111 237 / .15); }
    #aida-launcher:hover::before { animation: none; opacity: 0; }
    #aida-launcher:active { transform: scale(0.94); }
    #aida-launcher svg { width: 26px; height: 26px; fill: white; display: block; margin: auto; position: relative; z-index: 1; }

    /* Tooltip survol */
    #aida-launcher-tip {
      position: fixed; bottom: 48px; ${POSITION === "right" ? "right: 88px" : "left: 88px"};
      background: rgb(26 26 46 / .85); backdrop-filter: blur(8px);
      color: white; font-size: 0.78rem; font-weight: 500;
      padding: 7px 13px; border-radius: 8px; white-space: nowrap;
      pointer-events: none; z-index: 2147482999;
      opacity: 0; transform: translateX(${POSITION === "right" ? "6px" : "-6px"});
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      font-family: var(--aida-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    }
    #aida-launcher-tip::after {
      content: ""; position: absolute; top: 50%; ${POSITION === "right" ? "right: -4px" : "left: -4px"};
      width: 8px; height: 8px; background: rgb(26 26 46 / .85);
      transform: translateY(-50%) rotate(45deg);
    }
    #aida-launcher:hover + #aida-launcher-tip { opacity: 1; transform: translateX(0); }

    /* --- OVERLAY / BACKDROP IMMERSIF --- */
    #aida-overlay {
      position: fixed; inset: 0;
      z-index: 2147482999;
      background: rgb(0 0 0 / .6);
      backdrop-filter: blur(0px);
      -webkit-backdrop-filter: blur(0px);
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.4s ease, backdrop-filter 0.4s ease, -webkit-backdrop-filter 0.4s ease, visibility 0s 0.45s;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    #aida-overlay.aida-open {
      opacity: 1;
      visibility: visible;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: opacity 0.35s ease, backdrop-filter 0.35s ease, -webkit-backdrop-filter 0.35s ease, visibility 0s 0s;
    }

    /* --- POPUP CHAT (Liquid Glass Immersif) --- */
    #aida-window {
      width: 100%;
      max-width: 920px;
      height: min(680px, calc(100dvh - 48px));
      border-radius: 20px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      isolation: isolate;

      /* Gradient Premium — fond profond aux couleurs de l'accent */
      border: 1px solid rgb(255 255 255 / .12);
      background:
        radial-gradient(ellipse 85% 60% at 10% 15%, color-mix(in srgb, var(--aida-accent) 35%, transparent) 0%, transparent 70%),
        radial-gradient(ellipse 60% 50% at 90% 85%, color-mix(in srgb, var(--aida-accent-dark) 30%, transparent) 0%, transparent 60%),
        radial-gradient(ellipse 50% 40% at 50% 50%, color-mix(in srgb, var(--aida-accent) 8%, transparent) 0%, transparent 80%),
        linear-gradient(165deg, #0d0d2b 0%, #1a0d42 30%, #0f0a2e 60%, #060620 100%);
      backdrop-filter: blur(24px) saturate(150%);
      -webkit-backdrop-filter: blur(24px) saturate(150%);
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / .12),
        inset 0 -1px 0 rgb(255 255 255 / .06),
        0 24px 80px rgb(0 0 0 / .45),
        0 0 0 1px rgb(255 255 255 / .06);

      transform: scale(0.90) translateY(20px);
      opacity: 0;
      transition: transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1),
                  opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    #aida-window::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      border-radius: inherit;
      /* Reflets lumineux sur le gradient foncé */
      background:
        radial-gradient(ellipse 50% 25% at 18% 8%, rgb(255 255 255 / .20), transparent 70%),
        radial-gradient(ellipse 30% 20% at 82% 92%, rgb(255 255 255 / .06), transparent 55%),
        radial-gradient(ellipse 40% 30% at 55% 50%, color-mix(in srgb, var(--aida-accent) 6%, transparent), transparent 70%);
      pointer-events: none;
    }
    #aida-window::after {
      content: "";
      position: absolute;
      inset: 1px;
      border-radius: 19px;
      border: 1px solid rgb(255 255 255 / .12);
      pointer-events: none;
    }
    #aida-overlay.aida-open #aida-window {
      transform: scale(1) translateY(0);
      opacity: 1;
    }
    #aida-window, #aida-input, #aida-send {
      font-family: var(--aida-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    }

    /* --- EN-TÊTE --- */
    #aida-header {
      padding: 18px 44px;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgb(255 255 255 / .08);
      flex-shrink: 0;
    }
    #aida-header-left { display: flex; align-items: center; gap: 10px; }
    #aida-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: linear-gradient(135deg, var(--aida-accent), var(--aida-accent-dark));
      display: flex; align-items: center; justify-content: center;
      color: white; font-size: 1rem; font-weight: 700;
      flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    #aida-header-info { line-height: 1.3; }
    #aida-bot-name {
      font-weight: 700; font-size: 0.95rem;
      color: rgb(255 255 255 / .95);
      display: block;
      text-shadow: 0 1px 4px rgb(0 0 0 / .3);
    }
    #aida-header-status {
      font-size: 0.72rem;
      color: #4ade80;
      font-weight: 600;
      display: flex; align-items: center; gap: 4px;
    }
    #aida-header-status::before {
      content: ""; display: inline-block; width: 6px; height: 6px;
      border-radius: 50%; background: #2ecc71;
      animation: aida-pulse-status 2s ease-in-out infinite;
    }
    @keyframes aida-pulse-status {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    #aida-close {
      width: 32px; height: 32px; border-radius: 50%;
      background: rgb(255 255 255 / .1); border: none;
      color: rgb(255 255 255 / .75); font-size: 1rem; cursor: pointer;
      font-weight: 600;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s ease; flex-shrink: 0;
    }
    #aida-close:hover { background: rgb(255 255 255 / .2); color: rgb(255 255 255 / .95); }

    /* --- ZONE DE MESSAGES --- */
    #aida-messages {
      flex: 1; padding: 20px 44px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }
    #aida-messages::-webkit-scrollbar { width: 4px; }
    #aida-messages::-webkit-scrollbar-track { background: transparent; }
    #aida-messages::-webkit-scrollbar-thumb { background: rgb(255 255 255 / .15); border-radius: 99px; }

    .aida-msg {
      max-width: min(72%, 580px); padding: 10px 14px;
      font-size: 0.9rem; line-height: 1.55; white-space: pre-wrap;
      animation: aida-msg-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes aida-msg-in {
      from { opacity: 0; transform: translateY(8px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .aida-msg.aida-bot {
      align-self: flex-start;
      background: rgb(255 255 255 / .10);
      border: 1px solid rgb(255 255 255 / .15);
      border-bottom-left-radius: 4px;
      color: rgb(255 255 255 / .92);
      backdrop-filter: blur(12px);
      box-shadow: 0 1px 4px rgb(0 0 0 / .15);
    }
    .aida-msg.aida-user {
      align-self: flex-end;
      background: var(--aida-accent); color: white;
      border-bottom-right-radius: 4px;
      box-shadow: 0 2px 12px rgb(47 111 237 / .2), 0 1px 4px rgb(0 0 0 / .15);
    }
    .aida-msg.aida-typing {
      align-self: flex-start;
      background: rgb(255 255 255 / .08);
      border: 1px solid rgb(255 255 255 / .12);
      color: rgb(255 255 255 / .6);
      font-style: italic; font-weight: 500;
      display: flex; align-items: center; gap: 6px;
      backdrop-filter: blur(8px);
    }
    .aida-msg.aida-error {
      color: #ff8a80; background: rgb(255 0 0 / .15);
      border: 1px solid rgb(255 0 0 / .25);
    }

    .aida-typing-dots { display: inline-flex; gap: 3px; }
    .aida-typing-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: rgb(255 255 255 / .4);
      animation: aida-dot-bounce 1.2s ease-in-out infinite;
    }
    .aida-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .aida-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes aida-dot-bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* --- CARTE D'INVITATION --- */
    #aida-invite {
      padding: 28px 44px 20px; text-align: center;
      border-bottom: 1px solid rgb(255 255 255 / .06);
      flex-shrink: 0;
      animation: aida-msg-in 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1),
                  transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
                  margin-bottom 0.3s ease;
    }
    #aida-invite.aida-invite-out {
      opacity: 0;
      transform: translateY(-12px) scale(0.96);
      margin-bottom: -60px;
      pointer-events: none;
    }
    #aida-invite-avatar {
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, var(--aida-accent), var(--aida-accent-dark));
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 12px;
      color: white; font-size: 1.6rem; font-weight: 700;
      box-shadow: 0 4px 20px rgb(47 111 237 / .25);
    }
    #aida-invite h3 {
      margin: 0 0 4px; font-size: 1.05rem; font-weight: 700;
      color: rgb(255 255 255 / .95);
      text-shadow: 0 1px 4px rgb(0 0 0 / .3);
    }
    #aida-invite p {
      margin: 0 0 14px; font-size: 0.85rem;
      color: rgb(255 255 255 / .7);
      line-height: 1.5;
    }
    #aida-invite-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    #aida-invite-actions button {
      padding: 9px 16px; border-radius: 99px; border: none;
      font-size: 0.82rem; font-weight: 600; cursor: pointer;
      transition: all 0.2s ease; font-family: inherit;
    }
    #aida-invite-primary { background: var(--aida-accent); color: white; box-shadow: 0 2px 8px rgb(47 111 237 / .2); }
    #aida-invite-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgb(47 111 237 / .3); }
    #aida-invite-secondary { background: rgb(255 255 255 / .12); color: rgb(255 255 255 / .9); backdrop-filter: blur(4px); }
    #aida-invite-secondary:hover { background: rgb(255 255 255 / .2); }

    /* --- SUGGESTION CHIPS — Design Premium --- */
    #aida-suggestions {
      display: flex; flex-wrap: wrap; gap: 7px;
      padding: 12px 44px 18px;
      flex-shrink: 0;
      border-top: 1px solid rgb(255 255 255 / .06);
      position: relative;
    }
    #aida-suggestions.aida-suggestions-exit {
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }
    #aida-suggestions-label {
      width: 100%;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: rgb(255 255 255 / .4);
      margin-bottom: 2px;
    }
    #aida-suggestions button {
      padding: 7px 16px;
      border-radius: 99px;
      border: 1px solid rgb(255 255 255 / .12);
      background: rgb(255 255 255 / .08);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgb(255 255 255 / .85);
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      opacity: 0;
      transform: translateY(6px) scale(0.95);
      animation: aida-chip-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      box-shadow: 0 1px 3px rgb(0 0 0 / .15);
    }
    @keyframes aida-chip-in {
      from { opacity: 0; transform: translateY(6px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    #aida-suggestions button:hover {
      background: var(--aida-accent);
      color: white;
      border-color: var(--aida-accent);
      transform: translateY(-2px);
      box-shadow: 0 4px 18px rgb(0 0 0 / .3);
    }
    #aida-suggestions button:active {
      transform: translateY(0) scale(0.97);
      box-shadow: none;
    }
    /* Icône emoji dans les chips */
    #aida-suggestions button .aida-chip-icon {
      font-size: 0.85rem;
      line-height: 1;
    }

    /* --- PIED / FORMULAIRE --- */
    #aida-form {
      display: flex; gap: 12px; padding: 16px 44px 20px;
      border-top: 1px solid rgb(255 255 255 / .08);
      flex-shrink: 0;
    }
    #aida-input {
      flex: 1; border: 1px solid rgb(255 255 255 / .15);
      border-radius: 99px; padding: 12px 18px;
      font-size: 0.9rem; outline: none;
      background: rgb(255 255 255 / .08);
      color: rgb(255 255 255 / .92);
      transition: all 0.2s ease;
    }
    #aida-input:focus {
      border-color: var(--aida-accent);
      background: rgb(255 255 255 / .14);
      box-shadow: 0 0 0 3px rgb(47 111 237 / .2);
    }
    #aida-input::placeholder { color: rgb(255 255 255 / .4); font-weight: 500; }
    #aida-send {
      width: 44px; height: 44px; border-radius: 50%;
      background: var(--aida-accent); border: none; color: white;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 0.2s ease; flex-shrink: 0;
    }
    #aida-send:hover { background: var(--aida-accent-dark); transform: scale(1.05); }
    #aida-send:active { transform: scale(0.92); }
    #aida-send svg { width: 18px; height: 18px; fill: white; }
    #aida-send:disabled { opacity: 0.35; cursor: default; transform: none; }

    /* --- INDICATEUR SCROLL VERS LE BAS --- */
    #aida-scroll-bottom {
      position: absolute;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%) translateY(8px);
      z-index: 15;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
      padding: 8px 18px;
      border-radius: 99px;
      border: 1px solid rgb(255 255 255 / .15);
      background: rgb(255 255 255 / .12);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 4px 16px rgb(0 0 0 / .25);
      color: rgb(255 255 255 / .9);
      font-size: 0.78rem;
      font-weight: 600;
      font-family: var(--aida-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      user-select: none;
      -webkit-user-select: none;
    }
    #aida-scroll-bottom svg { flex-shrink: 0; }
    #aida-scroll-bottom.aida-scroll-visible {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateX(-50%) translateY(0);
    }
    #aida-scroll-bottom:hover {
      transform: translateX(-50%) translateY(-2px);
      box-shadow: 0 6px 22px rgb(0 0 0 / .35);
      background: rgb(255 255 255 / .2);
      border-color: rgb(255 255 255 / .25);
    }
    #aida-scroll-bottom:active {
      transform: translateX(-50%) translateY(0);
      box-shadow: 0 2px 8px rgb(0 0 0 / .1);
    }
    /* Micro-badge du nombre de nouveaux messages */
    #aida-scroll-bottom .aida-scroll-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 99px;
      background: var(--aida-accent);
      color: white;
      font-size: 0.65rem;
      font-weight: 700;
      line-height: 1;
    }
    /* Animation discrète d'attirance */
    @keyframes aida-scroll-bounce {
      0%, 100% { transform: translateX(-50%) translateY(0); }
      50% { transform: translateX(-50%) translateY(-3px); }
    }
    #aida-scroll-bottom.aida-scroll-visible {
      animation: aida-scroll-bounce 2.5s ease-in-out 3;
    }

    /* --- RESPONSIVE : 5 PALIERS --- */

    /* === TRÈS GRANDS ÉCRANS (≥1200px) — centré large === */
    @media (min-width: 1200px) {
      #aida-overlay { padding: 20px; }
      #aida-window { height: min(700px, calc(100dvh - 56px)); }
    }

    /* === DESKTOP STANDARD (960–1199px) — centré normal === */
    @media (min-width: 960px) and (max-width: 1199px) {
      #aida-overlay { padding: 16px; }
      #aida-window {
        max-width: 860px;
        height: min(640px, calc(100dvh - 48px));
      }
      #aida-messages { padding: 18px 36px; }
      #aida-header { padding: 16px 36px; }
      #aida-invite { padding: 24px 36px 18px; }
      #aida-suggestions { padding: 10px 36px 14px; }
      #aida-form { padding: 14px 36px 18px; }
    }

    /* === TABLETTE / PETIT ÉCRAN (620–959px) — bottom-sheet === */
    @media (max-width: 959px) {
      #aida-overlay {
        padding: 0;
        align-items: flex-end;
      }
      #aida-window {
        max-width: 100%;
        height: 100dvh;
        border-radius: 20px 20px 0 0;
        margin: 0;
        transform-origin: bottom center;
        /* Slide-up pur : le popup glisse depuis le bas de l'écran */
        transform: translateY(100%);
        transition: transform 0.5s cubic-bezier(0.32, 0.72, 0, 1),
                    opacity 0.35s ease;
      }
      #aida-overlay.aida-open #aida-window {
        transform: translateY(0);
      }
      #aida-window::after { border-radius: 19px 19px 0 0; }
      #aida-header { padding: 16px 28px; }
      #aida-messages { padding: 18px 28px; }
      #aida-invite { padding: 22px 28px 18px; }
      #aida-suggestions { padding: 10px 28px 14px; }
      #aida-form { padding: 14px 28px 18px; }
    }

    /* === GRAND TÉLÉPHONE (440–619px) — bottom-sheet compact + carrousel horizontal === */
    @media (max-width: 619px) {
      #aida-window { border-radius: 16px 16px 0 0; }
      #aida-window::after { border-radius: 15px 15px 0 0; }
      #aida-header { padding: 14px 20px; }
      #aida-avatar { width: 30px; height: 30px; font-size: 0.85rem; }
      #aida-bot-name { font-size: 0.88rem; }
      #aida-header-status { font-size: 0.68rem; }
      #aida-close { width: 28px; height: 28px; font-size: 0.85rem; }
      #aida-messages { padding: 16px 20px; gap: 10px; }
      .aida-msg {
        max-width: min(78%, 480px);
        font-size: 0.85rem;
        padding: 8px 12px;
      }
      #aida-invite { padding: 18px 20px 14px; }
      #aida-invite-avatar { width: 48px; height: 48px; font-size: 1.3rem; }
      #aida-invite h3 { font-size: 0.95rem; }
      #aida-invite p { font-size: 0.8rem; }
      #aida-invite-actions button { padding: 7px 13px; font-size: 0.78rem; }
      /* Carrousel horizontal scrollable */
      #aida-suggestions {
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scroll-snap-type: x mandatory;
        scroll-behavior: smooth;
        padding: 8px 20px 12px;
        gap: 6px;
        /* Masquer la scrollbar */
        scrollbar-width: none;
        -ms-overflow-style: none;
        /* Edge fade pour indiquer le scroll */
        mask-image: linear-gradient(to right, transparent 4px, black 20px, black calc(100% - 20px), transparent calc(100% - 4px));
        -webkit-mask-image: linear-gradient(to right, transparent 4px, black 20px, black calc(100% - 20px), transparent calc(100% - 4px));
      }
      #aida-suggestions::-webkit-scrollbar { display: none; }
      #aida-suggestions-label {
        width: auto;
        flex-shrink: 0;
        align-self: center;
        margin-right: 4px;
        margin-bottom: 0;
      }
      #aida-suggestions button {
        flex-shrink: 0;
        scroll-snap-align: start;
        padding: 5px 12px;
        font-size: 0.73rem;
        /* Les chips du carrousel apparaissent immédiatement */
        opacity: 1 !important;
        transform: none !important;
        animation: none !important;
      }
      #aida-form { padding: 12px 20px 16px; gap: 10px; }
      #aida-input { padding: 10px 16px; font-size: 0.85rem; }
      #aida-send { width: 40px; height: 40px; }
      #aida-send svg { width: 16px; height: 16px; }
    }

    /* === PETIT TÉLÉPHONE (<440px) — ultra-compact + carrousel === */
    @media (max-width: 439px) {
      #aida-window { border-radius: 12px 12px 0 0; }
      #aida-window::after { border-radius: 11px 11px 0 0; }
      #aida-header { padding: 12px 16px; }
      #aida-avatar { width: 26px; height: 26px; font-size: 0.75rem; }
      #aida-bot-name { font-size: 0.82rem; }
      #aida-header-status { font-size: 0.62rem; }
      #aida-close { width: 26px; height: 26px; font-size: 0.78rem; }
      #aida-messages { padding: 12px 16px; gap: 8px; }
      .aida-msg {
        max-width: 85%;
        font-size: 0.8rem;
        padding: 7px 10px;
        line-height: 1.5;
      }
      #aida-invite { padding: 16px 16px 12px; }
      #aida-invite-avatar { width: 40px; height: 40px; font-size: 1.1rem; margin-bottom: 8px; }
      #aida-invite h3 { font-size: 0.9rem; }
      #aida-invite p { font-size: 0.76rem; margin-bottom: 10px; }
      #aida-invite-actions { gap: 6px; }
      #aida-invite-actions button { padding: 6px 11px; font-size: 0.74rem; }
      /* Carrousel horizontal */
      #aida-suggestions {
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scroll-snap-type: x mandatory;
        scroll-behavior: smooth;
        padding: 6px 16px 10px;
        gap: 5px;
        scrollbar-width: none;
        -ms-overflow-style: none;
        mask-image: linear-gradient(to right, transparent 4px, black 16px, black calc(100% - 16px), transparent calc(100% - 4px));
        -webkit-mask-image: linear-gradient(to right, transparent 4px, black 16px, black calc(100% - 16px), transparent calc(100% - 4px));
      }
      #aida-suggestions::-webkit-scrollbar { display: none; }
      #aida-suggestions-label {
        width: auto;
        flex-shrink: 0;
        align-self: center;
        margin-right: 3px;
        margin-bottom: 0;
      }
      #aida-suggestions button {
        flex-shrink: 0;
        scroll-snap-align: start;
        padding: 4px 10px;
        font-size: 0.7rem;
        opacity: 1 !important;
        transform: none !important;
        animation: none !important;
      }
      #aida-form { padding: 10px 16px 14px; gap: 8px; }
      #aida-input { padding: 9px 14px; font-size: 0.82rem; }
      #aida-send { width: 36px; height: 36px; }
      #aida-send svg { width: 15px; height: 15px; }
    }

    /* --- ACCESSIBILITÉ --- */
    @media (prefers-reduced-transparency: reduce) {
      #aida-overlay { background: rgb(0 0 0 / .5); backdrop-filter: none; }
      #aida-window {
        background: #0d0d2b;
        backdrop-filter: none; -webkit-backdrop-filter: none;
        border: 1px solid rgb(255 255 255 / .12);
        box-shadow: 0 8px 30px rgb(0 0 0 / .35);
      }
      #aida-window::before, #aida-window::after { display: none; }
      .aida-msg.aida-bot { background: rgb(255 255 255 / .15); }
      #aida-input { background: rgb(255 255 255 / .12); }
      #aida-suggestions button { background: rgb(255 255 255 / .12); }
      #aida-scroll-bottom { background: rgb(255 255 255 / .18); }
    }
    @media (prefers-reduced-motion: reduce) {
      #aida-overlay, #aida-window { transition: none; }
      .aida-msg { animation: none; }
      #aida-scroll-bottom { animation: none !important; }
      #aida-scroll-bottom.aida-scroll-visible { animation: none !important; }
    }
  `;
  document.head.appendChild(style);

  // ─── Structure DOM ───────────────────────────────────────────────────────
  const SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  // Launcher avec tooltip
  const launcher = document.createElement("button");
  launcher.id = "aida-launcher";
  launcher.setAttribute("aria-label", "Ouvrir le chat IA Aïda");
  launcher.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.03 2 11c0 2.4 1.05 4.57 2.77 6.18-.15 1.32-.53 2.5-1.13 3.5a.5.5 0 00.58.72c1.7-.5 3.1-1.24 4.15-2 1.14.37 2.37.6 3.63.6 5.52 0 10-4.03 10-9s-4.48-9-10-9z"/></svg>';

  const launcherTip = document.createElement("div");
  launcherTip.id = "aida-launcher-tip";
  launcherTip.textContent = "Posez une question à IA Aïda";

  // Overlay
  const overlay = document.createElement("div");
  overlay.id = "aida-overlay";

  // Popup window
  const win = document.createElement("div");
  win.id = "aida-window";
  win.innerHTML = `
    <div id="aida-header">
      <div id="aida-header-left">
        <div id="aida-avatar">A</div>
        <div id="aida-header-info">
          <span id="aida-bot-name">IA Aïda</span>
          <span id="aida-header-status">En ligne</span>
        </div>
      </div>
      <button id="aida-close" aria-label="Fermer">✕</button>
    </div>
    <div id="aida-messages"></div>
    <form id="aida-form">
      <input id="aida-input" type="text" placeholder="Écris ton message..." autocomplete="off" />
      <button id="aida-send" type="submit" aria-label="Envoyer">${SEND_SVG}</button>
    </form>
    <div id="aida-scroll-bottom" role="button" tabindex="0" aria-label="Voir les nouveaux messages">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
      Nouveaux messages
    </div>
  `;

  overlay.appendChild(win);
  document.body.appendChild(launcher);
  document.body.appendChild(launcherTip);
  document.body.appendChild(overlay);

  // ─── Références DOM ──────────────────────────────────────────────────────
  const messagesEl = win.querySelector("#aida-messages");
  const formEl = win.querySelector("#aida-form");
  const inputEl = win.querySelector("#aida-input");
  const sendBtn = win.querySelector("#aida-send");
  const botNameEl = win.querySelector("#aida-bot-name");
  const closeBtn = win.querySelector("#aida-close");
  const avatarEl = win.querySelector("#aida-avatar");

  // ─── Session ─────────────────────────────────────────────────────────────
  let sessionId = sessionStorage.getItem("aida-session-id");
  if (!sessionId) {
    sessionId = "session-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem("aida-session-id", sessionId);
  }

  let isOpen = false;
  let hasShownInvite = false;
  let welcomeShown = false;
  let suggestions = [];
  let suggestionsLoaded = false;

  // ─── Suggestions ─────────────────────────────────────────────────────────
  const suggestionsPromise = fetch(BACKEND_ORIGIN + "/api/widget-suggestions")
    .then((r) => r.json())
    .then((data) => {
      suggestions = data.suggestions || [];
      suggestionsLoaded = true;
    })
    .catch(() => { suggestionsLoaded = true; });

  // Associe un emoji pertinent à une question selon son contenu
  function suggestIcon(question) {
    const q = question.toLowerCase();
    if (/prix|tarif|co[uû]t|forfait|combien|€|\$|payer|factur/.test(q)) return "💰";
    if (/contact|joindre|appeler|t[eé]l[eé]phone|email|adresse|o[ùu]/.test(q)) return "📞";
    if (/service|offre|solution|propos[ée]|expertise/.test(q)) return "💡";
    if (/comment|aide|pouvez|possible|conseil|guide/.test(q)) return "🤝";
    if (/d[eé]lai|livraison|exp[eé]dition|retour|rembours/.test(q)) return "📦";
    if (/garantie|satisfait|qualit[ée]|fiable/.test(q)) return "✅";
    if (/acc[èe]s|inscri|compte|connecter|login|mot de passe/.test(q)) return "🔐";
    if (/d[ée]lai|temps|quand|dur[ée]e|date|disponib/.test(q)) return "⏱️";
    if (/produit|article|catalogue|choisir|recommand/.test(q)) return "🛍️";
    if (/info|renseign|savoir|parlez|propos|question/.test(q)) return "ℹ️";
    return "💬";
  }

  function showSuggestionChips() {
    const old = document.getElementById("aida-suggestions");
    if (old) {
      // Transition de sortie avant suppression
      old.classList.add("aida-suggestions-exit");
      setTimeout(() => old.remove(), 220);
    }
    if (!suggestions || suggestions.length === 0) return;

    const container = document.createElement("div");
    container.id = "aida-suggestions";

    // Label discret "Suggestions"
    const label = document.createElement("span");
    label.id = "aida-suggestions-label";
    label.textContent = "Suggestions";
    container.appendChild(label);

    suggestions.forEach((q, i) => {
      const chip = document.createElement("button");
      chip.innerHTML = `<span class="aida-chip-icon">${suggestIcon(q)}</span><span>${q}</span>`;
      // Staggered animation : chaque chip apparaît 70ms après le précédent
      chip.style.animationDelay = `${i * 70}ms`;
      chip.addEventListener("click", () => {
        inputEl.value = q;
        inputEl.dispatchEvent(new Event("input"));
        formEl.dispatchEvent(new Event("submit"));
      });
      container.appendChild(chip);
    });
    messagesEl.parentNode.insertBefore(container, messagesEl.nextSibling);
  }

  // ─── Fonction d'animation de sortie de l'invite ─────────────────────────
  function fadeOutInvite(inviteEl) {
    if (!inviteEl) return Promise.resolve();
    inviteEl.classList.add("aida-invite-out");
    return new Promise((resolve) => {
      // Attend la fin de la transition (300ms) avant de supprimer du DOM
      setTimeout(() => {
        if (inviteEl.parentNode) inviteEl.remove();
        resolve();
      }, 320);
    });
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────
  let pendingScrollCount = 0;

  function isNearBottom() {
    const threshold = 100;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const el = document.getElementById("aida-scroll-bottom");
    if (el) {
      el.classList.remove("aida-scroll-visible");
      el.querySelector(".aida-scroll-count")?.remove();
    }
    pendingScrollCount = 0;
  }

  function updateScrollIndicator() {
    const el = document.getElementById("aida-scroll-bottom");
    if (!el) return;
    if (isNearBottom()) {
      el.classList.remove("aida-scroll-visible");
      el.querySelector(".aida-scroll-count")?.remove();
      pendingScrollCount = 0;
    } else if (pendingScrollCount > 0) {
      el.classList.add("aida-scroll-visible");
      let badge = el.querySelector(".aida-scroll-count");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "aida-scroll-count";
        el.appendChild(badge);
      }
      badge.textContent = pendingScrollCount > 99 ? "99+" : pendingScrollCount;
    }
  }

  function addMessage(text, type) {
    const el = document.createElement("div");
    el.className = "aida-msg aida-" + type;
    if (type === "typing") {
      el.innerHTML = '<span class="aida-typing-dots"><span></span><span></span><span></span></span>';
    } else {
      el.textContent = text;
    }
    messagesEl.appendChild(el);

    if (type !== "typing" && isNearBottom()) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (type !== "typing") {
      pendingScrollCount++;
      updateScrollIndicator();
    }
    return el;
  }

  function showInviteCard() {
    // Évite les doublons : si une carte d'invite existe déjà, ne pas en créer une autre
    if (document.getElementById("aida-invite")) return;

    const invite = document.createElement("div");
    invite.id = "aida-invite";
    invite.innerHTML = `
      <div id="aida-invite-avatar">A</div>
      <h3>Bienvenue 👋</h3>
      <p>Comment puis-je vous aider ? Posez votre question ou découvrez ce que je peux faire pour vous.</p>
      <div id="aida-invite-actions">
        <button id="aida-invite-primary">💬 Poser une question</button>
        <button id="aida-invite-secondary">✨ Découvrir</button>
      </div>
    `;
    messagesEl.parentNode.insertBefore(invite, messagesEl);

    invite.querySelector("#aida-invite-primary").addEventListener("click", () => {
      fadeOutInvite(invite);
      hasShownInvite = true;
      inputEl.focus();
      inputEl.placeholder = "Que puis-je faire pour vous ?";
    });
    invite.querySelector("#aida-invite-secondary").addEventListener("click", () => {
      hasShownInvite = true;
      fadeOutInvite(invite).then(() => {
        showWelcomeMessage();
        setTimeout(showSuggestionChips, 400);
      });
    });
  }

  function showWelcomeMessage() {
    if (welcomeShown) return; // Évite les doublons en cas de double-clic rapide
    welcomeShown = true;
    hasShownInvite = true;
    addMessage(
      "Ravie de vous rencontrer ! Je suis IA Aïda, votre assistante dédiée. Je peux vous renseigner sur nos services, vous orienter vers les bonnes ressources, ou répondre à toutes vos questions. Que souhaitez-vous explorer ?",
      "bot"
    );
  }

  // ─── Chargement de la config ──────────────────────────────────────────────
  fetch(BACKEND_ORIGIN + "/api/widget-config")
    .then((r) => r.json())
    .then((cfg) => {
      botNameEl.textContent = cfg.botName || "IA Aïda";
      avatarEl.textContent = (cfg.botName || "IA Aïda").charAt(0).toUpperCase();
      if (cfg.accentColor) document.documentElement.style.setProperty("--aida-accent", cfg.accentColor);
      if (cfg.accentColorDark) document.documentElement.style.setProperty("--aida-accent-dark", cfg.accentColorDark);
      if (cfg.fontFamily && cfg.fontFamily !== "system-ui" && cfg.fontFamily !== "inherit") {
        const fontName = cfg.fontFamily;
        // Vérifie si cette Google Font n'est pas déjà chargée
        const existingLinks = document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
        let alreadyLoaded = false;
        existingLinks.forEach((el) => {
          if (el.href.includes(fontName.replace(/\s+/g, "+"))) alreadyLoaded = true;
        });
        if (!alreadyLoaded) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, "+")}:wght@400;500;600;700&display=swap`;
          document.head.appendChild(link);
        }
        document.documentElement.style.setProperty(
          "--aida-font-family",
          `"${fontName}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
        );
      }
    })
    .catch(() => {});

  // ─── Ouverture / Fermeture ────────────────────────────────────────────────
  function openChat() {
    isOpen = true;
    overlay.classList.add("aida-open");
    document.body.style.overflow = "hidden";

    // Focus sur l'input après l'animation d'ouverture
    setTimeout(() => { inputEl.focus(); }, 350);

    if (!hasShownInvite) {
      setTimeout(() => {
        (suggestionsLoaded ? Promise.resolve() : suggestionsPromise).then(() => {
          showInviteCard();
          messagesEl.scrollTop = 0;
        });
      }, 400);
    }
    inputEl.placeholder = "Écris ton message...";
  }

  function closeChat() {
    isOpen = false;
    overlay.classList.remove("aida-open");
    document.body.style.overflow = "";
    inputEl.blur();
  }

  launcher.addEventListener("click", () => {
    if (!isOpen) openChat(); else closeChat();
  });

  closeBtn.addEventListener("click", closeChat);

  // Fermeture au clic sur le backdrop
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeChat();
  });

  // Fermeture avec la touche Echap
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeChat();
  });

  // ─── Envoi de message ────────────────────────────────────────────────────
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;

    const invite = document.getElementById("aida-invite");
    if (invite) { fadeOutInvite(invite); hasShownInvite = true; }

    addMessage(text, "user");
    inputEl.value = "";
    sendBtn.disabled = true;

    const typingEl = addMessage("...", "typing");

    try {
      const res = await fetch(BACKEND_ORIGIN + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await res.json();
      typingEl.remove();

      if (res.ok && data.reply) {
        addMessage(data.reply, "bot");
        setTimeout(showSuggestionChips, 600);
      } else {
        addMessage(data.error || "Une erreur est survenue. Veuillez réessayer.", "error");
      }
    } catch (err) {
      typingEl.remove();
      addMessage("Impossible de contacter le serveur. Vérifiez votre connexion.", "error");
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  });

  inputEl.addEventListener("input", () => {
    sendBtn.disabled = !inputEl.value.trim();
  });
  sendBtn.disabled = true;

  // ─── Indicateur de scroll vers le bas ───────────────────────────────────
  messagesEl.addEventListener("scroll", () => {
    if (isNearBottom()) {
      const el = document.getElementById("aida-scroll-bottom");
      if (el) {
        el.classList.remove("aida-scroll-visible");
        el.querySelector(".aida-scroll-count")?.remove();
      }
      pendingScrollCount = 0;
    }
  }, { passive: true });

  const scrollIndicator = document.getElementById("aida-scroll-bottom");
  if (scrollIndicator) {
    scrollIndicator.addEventListener("click", scrollToBottom);
    // Support clavier (Entrée / Espace)
    scrollIndicator.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        scrollToBottom();
      }
    });
  }
})();
