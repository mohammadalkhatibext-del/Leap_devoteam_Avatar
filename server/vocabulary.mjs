/**
 * The words this booth hears that a general recogniser has never heard.
 *
 * "ديفوتيم" is not a word. Left to itself the recogniser splits it into two real ones
 * — "ديفو تيم" — or lands one letter out on "ديفوتين", and the visitor watches the
 * avatar answer a question about a company whose name it just got wrong. Measured on
 * the Arabic fixtures, two voices, the phrases that contain the brand:
 *
 *                        brand correct
 *   OpenAI, no prompt        2 / 6
 *   OpenAI, this list        6 / 6
 *
 * It also pulled "Google Cloud" and "Kubernetes" back into Latin script from
 * "كوك كلاود" and "كوبرنيتيس".
 *
 * "Azure" was the one term the list could not rescue on `gpt-4o-transcribe` — it came
 * through as "أجر" or "أزور" no matter what. Moving to `gpt-transcribe` fixed it: the
 * code-switching fixture now returns "AWS وAzure وGoogle Cloud" intact. The list and
 * the model do different jobs, and both are load-bearing.
 *
 * WHY IT IS A BARE LIST AND MUST STAY ONE. An earlier version wrapped these terms in a
 * framing sentence — "a conversation at the Devoteam stand at LEAP Riyadh…". The brand
 * name came out right and the *greeting* came out wrong: "هلا وغلا" was rewritten as
 * "مرحباً". gpt-4o-transcribe imitates the register of its prompt, so a prompt written
 * in MSA prose quietly converts Gulf speech into MSA — the one thing SCORING.md is
 * most careful to preserve. Nothing here may read as a sentence, an instruction, or a
 * style. Terms only.
 *
 * No `language` hint travels with it, deliberately. The booth is bilingual and decides
 * the answer's language from the script of the transcript; pinning the recogniser to
 * Arabic would mangle every English visitor to save a fault this list already fixes.
 *
 * Add to it when a visitor is misheard twice on the same word — a partner name, a
 * product, a speaker. It is cheap: the terms ride along with a request that was being
 * made anyway.
 */
export const VOCABULARY = [
  "ديفوتيم", "Devoteam", "ليب", "LEAP", "الرياض", "السعودية",
  "الحوسبة السحابية", "الأمن السيبراني", "الذكاء الاصطناعي",
  "أتمتة الأعمال", "الاستراتيجية الرقمية", "البيانات",
  "AWS", "Azure", "Google Cloud", "Kubernetes", "ServiceNow", "Salesforce",
];

/** OpenAI's `prompt` field takes free text; a comma-separated list reads as terms. */
export const asPrompt = () => VOCABULARY.join("، ");
