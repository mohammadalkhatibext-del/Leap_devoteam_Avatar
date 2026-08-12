/**
 * Booth UI strings.
 *
 * The page language and the *answer* language are separate ideas and must not be
 * conflated. This controls the chrome a visitor reads — buttons, labels, direction.
 * Which language the avatar replies in is decided per question by what the visitor
 * actually spoke; the page language only supplies the default when speech recognition
 * has nothing to go on (a typed question, or an unintelligible clip).
 *
 * The operator panel is deliberately not translated. It is read by booth staff on a
 * laptop, it is full of provider names and millisecond timings, and an operator
 * hunting a failure at the stand should see the same words as the README.
 *
 * Tone follows §11: plain, direct, "you" rather than "we", and a failure always
 * points at a human rather than describing itself.
 */

export const STRINGS = {
  ar: {
    dir: "rtl",
    htmlLang: "ar",
    title: "مساعد ديفوتيم",
    subtitle: "LEAP — الرياض",

    // Two weights in one heading, emphasis on the word that carries the meaning —
    // §2.3. The <b> is the only markup allowed through applyLang.
    attractTitle: "اسألني عن <b>ديفوتيم</b>",
    attractLead: "اضغط وتحدّث، أو اكتب سؤالك.",

    connecting: "جارٍ الاتصال",
    stopSpeaking: "إيقاف الكلام",
    newVisitor: "زائر جديد",
    talk: "اضغط وتحدّث",
    listening: "أستمع إليك…",
    speakNow: "تفضّل…",
    orType: "أو اكتب سؤالك",
    placeholder: "ما هي ديفوتيم؟",

    transcript: "النص",
    transcriptEmpty: "سيظهر الجواب هنا نصاً أثناء الحديث.",

    sources: "المصادر",
    sourcesCount: "المصادر",
    sourcesEmpty: "تظهر هنا المصادر التي استند إليها الجواب.",
    noSources: "لا توجد مصادر.",
    ungrounded: "إجابة بدون مصدر — راجعها قبل الاعتماد عليها.",

    notConnected: "غير متصل",
    ready: "جاهز",
    thinking: "يفكر",
    speaking: "يتحدث",
    hearing: "يستمع",
    transcribing: "يكتب ما قلت",

    heardNothing: "ما سمعتك زين، ممكن تعيد؟",
    error: "عذراً، حدث خطأ. تفضلوا بسؤال أحد الزملاء في الجناح.",
    idleReset: "انتهت الجلسة — أهلاً بالزائر التالي",

    // The renderer is the part that fails at an exhibition; the answer engine keeps
    // working without it. So this says what still works rather than what broke.
    offlineTitle: "الصورة غير متاحة",
    offlineBody: "اكتب سؤالك وسيصلك الجواب نصاً، أو اسأل أحد الزملاء في الجناح.",
    // Sits on the stage whenever there is no picture, in every phase. Says what still
    // works rather than what broke — the answer engine is a separate service.
    textOnly: "الصورة غير متاحة الآن. اسأل وسيصلك الجواب نصاً.",

    privacy: "لا يتم تسجيل صوتك أو حفظه.",
    themeLight: "الوضع الفاتح",
    themeDark: "الوضع الداكن",
    switchLang: "English",
    admin: "الإعدادات",

    suggestions: [
      "ما هي ديفوتيم؟",
      "هل لديكم مكاتب في السعودية؟",
      "كيف تدعمون رؤية ٢٠٣٠؟",
      "ما علاقتكم بجوجل كلاود؟",
    ],
  },

  en: {
    dir: "ltr",
    htmlLang: "en",
    title: "Devoteam Assistant",
    subtitle: "LEAP — Riyadh",

    attractTitle: "Ask me about <b>Devoteam</b>",
    attractLead: "Press and speak, or type your question.",

    connecting: "Connecting",
    stopSpeaking: "Stop speaking",
    newVisitor: "New visitor",
    talk: "Press and speak",
    listening: "Listening…",
    speakNow: "Go ahead…",
    orType: "Or type your question",
    placeholder: "What is Devoteam?",

    transcript: "Transcript",
    transcriptEmpty: "The answer appears here as text while it is spoken.",

    sources: "Sources",
    sourcesCount: "Sources",
    sourcesEmpty: "The sources behind each answer appear here.",
    noSources: "No sources.",
    ungrounded: "Answer with no source — check it before relying on it.",

    notConnected: "Not connected",
    ready: "Ready",
    thinking: "Thinking",
    speaking: "Speaking",
    hearing: "Listening",
    transcribing: "Transcribing",

    heardNothing: "Sorry, I didn't catch that — could you say it again?",
    error: "Sorry, something went wrong. Please ask one of my colleagues at the stand.",
    idleReset: "Session ended — welcome to the next visitor",

    offlineTitle: "The picture isn't available",
    offlineBody: "Type your question and you'll get the answer as text, or ask one of my colleagues at the stand.",
    textOnly: "No picture right now. Ask anyway — the answer comes as text.",

    privacy: "Your voice isn't recorded or stored.",
    themeLight: "Light mode",
    themeDark: "Dark mode",
    switchLang: "العربية",
    admin: "Settings",

    suggestions: [
      "What is Devoteam?",
      "Do you have offices in Saudi Arabia?",
      "How do you support Vision 2030?",
      "What is your relationship with Google Cloud?",
    ],
  },
};

const KEY = "devoteam-lang";

/** Page language: ?lang= wins, then the last choice, then Arabic (the booth is in Riyadh). */
export function currentLang() {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "ar" || q === "en") return q;
  const saved = localStorage.getItem(KEY);
  return saved === "en" ? "en" : "ar";
}

export function setLang(lang) {
  localStorage.setItem(KEY, lang);
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  location.href = url.toString();
}

export const t = (lang) => STRINGS[lang] ?? STRINGS.ar;

/**
 * Apply direction and language to the document, and fill every translated element.
 *
 *   data-t             textContent
 *   data-t-html        innerHTML, but only <b> survives — see below
 *   data-t-placeholder placeholder
 *   data-t-label       aria-label, for controls with no visible text of their own
 */
export function applyLang(lang) {
  const s = t(lang);
  document.documentElement.lang = s.htmlLang;
  document.documentElement.dir = s.dir;

  for (const el of document.querySelectorAll("[data-t]")) {
    const val = s[el.dataset.t];
    if (typeof val === "string") el.textContent = val;
  }

  // Headings need two weights (§2.3), which means one tag inside the string. Every
  // other tag is escaped rather than parsed — these strings are ours today, but a
  // translation file is exactly the kind of thing that later gets edited by someone
  // who is not thinking about markup.
  for (const el of document.querySelectorAll("[data-t-html]")) {
    const val = s[el.dataset.tHtml];
    if (typeof val !== "string") continue;
    el.innerHTML = val
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/&lt;b&gt;/g, "<b>")
      .replace(/&lt;\/b&gt;/g, "</b>");
  }

  for (const el of document.querySelectorAll("[data-t-placeholder]")) {
    const val = s[el.dataset.tPlaceholder];
    if (typeof val === "string") el.placeholder = val;
  }

  for (const el of document.querySelectorAll("[data-t-label]")) {
    const val = s[el.dataset.tLabel];
    if (typeof val === "string") el.setAttribute("aria-label", val);
  }

  return s;
}
