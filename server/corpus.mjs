import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KB = path.join(ROOT, "devoteam_information", "devoteam-knowledge-base.md");

/**
 * Section 0 is instructions *for* the avatar, not facts *about* Devoteam. It belongs
 * in the system prompt, not in the citable document set — otherwise the model can
 * "cite" its own guardrails as if they were a source about the company.
 */
const INSTRUCTION_SECTIONS = new Set(["0"]);

/** Split the knowledge base on its top-level `## N. Title` headings. */
function splitSections(markdown) {
  const sections = [];
  // Keep the heading with its body: split before every line starting with "## ".
  for (const chunk of markdown.split(/\n(?=## )/g)) {
    const heading = chunk.match(/^## +(.+)$/m);
    if (!heading) continue; // preamble before the first §
    const title = heading[1].trim();
    const number = title.match(/^(\d+)\./)?.[1] ?? null;
    sections.push({ number, title, text: chunk.trim() });
  }
  return sections;
}

/**
 * Load the corpus as Claude document blocks with citations enabled.
 *
 * One block per section rather than one block for the whole file: a citation then
 * names the section it came from ("10. Devoteam Middle East"), which is what the
 * booth staff need to check an answer. Whole-file would only give char offsets.
 */
export async function loadCorpus() {
  const markdown = await readFile(KB, "utf8");
  const sections = splitSections(markdown).filter(
    (s) => !INSTRUCTION_SECTIONS.has(s.number),
  );

  if (!sections.length) throw new Error(`no sections parsed from ${KB}`);

  const blocks = sections.map((s) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: s.text },
    title: s.title,
    citations: { enabled: true },
  }));

  // Caching is a prefix match, so the breakpoint goes on the LAST document —
  // everything before it (system prompt + every other section) is then cached.
  // The visitor's question is appended after this block and stays uncached,
  // which is the point: one corpus write, then ~0.1x reads for every question.
  blocks.at(-1).cache_control = { type: "ephemeral" };

  return { blocks, sections };
}
