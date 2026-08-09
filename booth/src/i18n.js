/**
 * Booth UI strings.
 *
 * The page language and the *answer* language are separate ideas and must not be
 * conflated. This controls the chrome a visitor reads — buttons, labels, direction.
 * Which language the avatar replies in is decided per question by what the visitor
 * actually spoke; the page language only supplies the default when speech recognition
 * has nothing to go on (a typed question, or an unintelligible clip).
 */

export const STRINGS = {
  ar: {
    dir: "rtl",
    htmlLang: "ar",
    title: "مساعد ديفوتيم",
    subtitle: "LEAP — الرياض",
    connect: "تشغيل",
    connecting: "جارٍ الاتصال",
    connectFailed: "فشل الاتصال",
    stopSpeaking: "إيقاف الكلام",
    newVisitor: "زائر جديد",
    talk: "🎤 اضغط وتحدّث",
    listening: "أستمع إليك…",
    speakNow: "تفضّل…",
    orType: "أو اكتب سؤالك",
    placeholder: "ما هي ديفوتيم؟",
    sources: "المصادر",
    sourcesEmpty: "تظهر هنا المصادر التي استند إليها الجواب.",
    noSources: "لا توجد مصادر.",
    ungrounded: "⚠ إجابة بدون مصدر — راجعها قبل الاعتماد عليها.",
    log: "سجل",
    notConnected: "غير متصل",
    ready: "جاهز",
    thinking: "يفكر",
    speaking: "يتحدث",
    hearing: "يستمع",
    transcribing: "يكتب ما قلت",
    heardNothing: "ما سمعتك زين، ممكن تعيد؟",
    error: "عذراً، حدث خطأ. تفضلوا بسؤال أحد الزملاء في الجناح.",
    idleReset: "انتهت الجلسة — أهلاً بالزائر التالي",
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
    connect: "Start",
    connecting: "Connecting",
    connectFailed: "Connection failed",
    stopSpeaking: "Stop speaking",
    newVisitor: "New visitor",
    talk: "🎤 Tap and speak",
    listening: "Listening…",
    speakNow: "Go ahead…",
    orType: "Or type your question",
    placeholder: "What is Devoteam?",
    sources: "Sources",
    sourcesEmpty: "The sources behind each answer appear here.",
    noSources: "No sources.",
    ungrounded: "⚠ Answer with no source — check it before relying on it.",
    log: "Log",
    notConnected: "Not connected",
    ready: "Ready",
    thinking: "Thinking",
    speaking: "Speaking",
    hearing: "Listening",
    transcribing: "Transcribing",
    heardNothing: "Sorry, I didn't catch that — could you say it again?",
    error: "Sorry, something went wrong. Please ask one of my colleagues at the stand.",
    idleReset: "Session ended — welcome to the next visitor",
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

/** Apply direction and language to the document, and fill every [data-t] element. */
export function applyLang(lang) {
  const s = t(lang);
  document.documentElement.lang = s.htmlLang;
  document.documentElement.dir = s.dir;
  for (const el of document.querySelectorAll("[data-t]")) {
    const val = s[el.dataset.t];
    if (typeof val === "string") el.textContent = val;
  }
  for (const el of document.querySelectorAll("[data-t-placeholder]")) {
    const val = s[el.dataset.tPlaceholder];
    if (typeof val === "string") el.placeholder = val;
  }
  return s;
}
