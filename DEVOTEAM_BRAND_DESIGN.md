# Devoteam Brand — Web Design Instructions

**Source:** `Devoteam_BrandGuidelines_April_2026 005_compressed.pdf` (53 pp.)
**Scope:** Everything a coding agent needs to rebrand this app's UI from HRSD to Devoteam.
**Audience:** Coding agents implementing CSS/React in this repo.

> **How to read this doc.** Sections marked **[CANON]** are lifted directly from the
> brand guidelines — implement them as written. Sections marked **[DERIVED]** are
> extensions I added because the guidelines don't cover a case the web app needs
> (dark surfaces, semantic status colours, accessible text variants). Derived values
> are built from canon colours and are flagged so a brand reviewer can approve or
> replace them. Never silently promote a derived value into canon.

---

## 0. Non-negotiables

Read these first. Everything else is detail.

1. **Montserrat is the only typeface.** No exceptions on web. (Aptos is the MS Office
   fallback only — irrelevant here.)
2. **Never use pure black (`#000`) for text.** Use Dark Grey `#3c3c3a`. Black creates a
   "harsh composition" and is explicitly banned.
3. **Red Poppy is used sparingly.** It is an accent and CTA colour, not a background wash.
4. **White is an active colour**, not empty space. It carries the premium positioning.
   Generous white space is a brand requirement, not a layout accident.
5. **One radius system.** 15px is the house radius. Do not mix random radii.
6. **No background circles.** The old circular decoration system is retired. Do not put
   filled circles behind icons, avatars, or team photos.
7. **No drop shadows on text.** Ever.
8. **Secondary and Accent colours are never used for text.**
9. **Glassmorphism is a premium accent, not a default surface.** Never stack glass on glass.
10. **Neon is an accent only.** Max 1–2 neon focal points per screen.

---

## 1. Colour

### 1.1 Primary — text, icons, CTAs **[CANON]**

| Name | HEX | RGB | Pantone | Use |
|---|---|---|---|---|
| Red Poppy | `#f8485e` | 248, 72, 94 | 1785 C | CTAs, highlights, key headers, hyperlinks, brandmark |
| Dark Grey | `#3c3c3a` | 60, 60, 58 | 426 | All body text, most icons, wordmark |
| White | `#ffffff` | 255, 255, 255 | — | Surfaces, text on dark/images. An *active* colour |
| Light Grey | `#efeeee` | 239, 238, 238 | Cool Grey 1 C | Section differentiation, borders, disabled states |

**Red Poppy shades** — for process/progression graphics (stages, steps, funnels), where
light→dark conveys progression:

| Name | HEX | RGB | Pantone |
|---|---|---|---|
| Red Poppy | `#f8485e` | 248, 72, 94 | 1785 C |
| Poppy Light | `#fca2ae` | 252, 162, 174 | 197 C |
| Poppy Lighter | `#fddade` | 253, 218, 222 | 196 C |

### 1.2 Secondary — backgrounds and graphics only **[CANON]**

Decorative. **Never render text in these.** Use for section backgrounds, illustration
fills, and graphic shapes.

| Name | HEX | RGB | Pantone |
|---|---|---|---|
| Intense Fire | `#fcc354` | 252, 195, 84 | 135 C |
| Fresh Mint | `#5ab891` | 90, 184, 145 | 136-5 C |
| Aqua | `#d7ebe7` | 215, 235, 231 | 9520 C |
| Beige | `#efeadc` | 239, 234, 220 | 7527 C |

### 1.3 Accent — data visualisation only **[CANON]**

Reserved for **colour-coding sections, charts, infographics, and data points.**
Explicitly banned as: text colour, background colour, general graphics colour, and
logo colour.

| Name | HEX | RGB | Pantone |
|---|---|---|---|
| Blue Lagoon | `#4a8cca` | 74, 140, 202 | 279 C |
| Candy | `#ec86a3` | 236, 134, 163 | 2038 C |
| Violet | `#63238c` | 99, 35, 140 | 268 C |

**Chart series order:** Red Poppy → Blue Lagoon → Violet → Candy → Intense Fire →
Fresh Mint. Lead with the brand colour, then accents, then secondaries if you need
more than four series.

### 1.4 Accessibility-safe variants **[DERIVED]**

The guidelines themselves mandate a **minimum 4.5:1 contrast ratio** for text (stated in
the glass-effect section). Three canon pairings do not meet it, so the app needs deepened
variants for small text. Measured ratios:

| Pairing | Ratio | Verdict |
|---|---|---|
| Red Poppy `#f8485e` text on white | **3.45:1** | ✗ fails AA body text; ✓ passes for large text (≥24px, or ≥18.66px bold) and for UI component boundaries (3:1) |
| White text on Red Poppy fill | **3.45:1** | ✗ fails AA for standard button labels |
| Dark Grey `#3c3c3a` on white | **11.06:1** | ✓ excellent |

Derived tokens to close the gap — these keep the poppy hue but darken it:

| Token | HEX | Ratio on white | Use |
|---|---|---|---|
| `--dv-poppy-ink` | `#d6334a` | **4.74:1** | Hyperlinks and any Red Poppy text below 24px. Also use as the *fill* for standard-size primary buttons so white labels pass AA (4.74:1). |
| `--dv-poppy` | `#f8485e` | 3.45:1 | Canon Red Poppy. Use for large display text, fills behind large/bold labels, hero CTAs, icons, borders, glows, and all decorative work. |

**Rule of thumb:** if the text on or in poppy is smaller than 24px, use `--dv-poppy-ink`.
Otherwise use `--dv-poppy`. Both read as the same brand colour at a glance.

### 1.5 Semantic status colours **[DERIVED]**

The guidelines define no success/warning/error colours, and Red Poppy occupies the slot a
user would normally read as "error". Resolution:

| State | Fill / icon | Text-safe variant | Notes |
|---|---|---|---|
| Success | Fresh Mint `#5ab891` | `#2f7d5c` | Mint alone is 2.41:1 — decorative only, never for text |
| Warning | Intense Fire `#fcc354` | `#8a5a00` | Amber fill always needs dark grey text on it |
| Info | Blue Lagoon `#4a8cca` | `#2f6fa8` | Accent colour used semantically — flag for brand review |
| Error / destructive | `#c02638` | `#c02638` | Deeper than Red Poppy so it reads as *danger*, not *brand* |

Because error red and brand red are neighbours, **never rely on colour alone** for
destructive actions. Always pair with an icon and an explicit verb ("Delete", not "OK").

### 1.6 Dark mode surfaces **[DERIVED]**

The guidelines reference dark surfaces and dark-theme glass but publish no hexes.
Derived from Dark Grey `#3c3c3a`:

| Token | HEX | Use |
|---|---|---|
| `--dv-surface-base` | `#141413` | Page background |
| `--dv-surface-1` | `#1e1e1d` | Default card |
| `--dv-surface-2` | `#2a2a28` | Elevated card / popover |
| `--dv-surface-3` | `#3c3c3a` | Highest elevation (canon Dark Grey) |
| `--dv-text-invert` | `#ffffff` | Body text on dark |
| `--dv-text-invert-muted` | `rgba(255,255,255,0.72)` | Secondary text on dark |

Neon and glass both perform best here — dark mode is where the brand's signature
elements are meant to live.

---

## 2. Typography

### 2.1 Family **[CANON]**

**Montserrat.** Load weights **300, 400, 500, 600, 700, 800** (the web scale needs 600
and 800, which aren't in the print weight list — the variable font covers all six).

```css
/* Self-host: the app already self-hosts fonts and uses font-display: optional
   to avoid CLS. Keep that pattern — do not switch to a CDN <link>. */
@font-face {
  font-family: 'Montserrat';
  src: url('/fonts/montserrat-variable.woff2') format('woff2-variations');
  font-weight: 300 800;
  font-style: normal;
  font-display: optional;
}
```

Fallback stack: `'Montserrat', 'Helvetica Neue', Arial, sans-serif`.

Montserrat is SIL Open Font Licensed — fetch the variable woff2 from Google Fonts and
commit it to `public/fonts/`. **Self-host; do not link the Google Fonts CDN** (render
blocking, and it leaks user IPs to a third party). Then delete `public/fonts/saud.woff2`
and its `@font-face` block.

### 2.2 Web type scale **[CANON]**

Implement this table verbatim.

| Element | px | rem | Weight | Line height | Usage |
|---|---|---|---|---|---|
| Display / Hero | 64 | 4.0 | Extra Bold (800) | 1.1 | Landing page headers |
| H1 | 48 | 3.0 | Bold (700) | 1.2 | Main page titles |
| H2 | 36 | 2.25 | Bold (700) | 1.25 | Major section breaks |
| H3 | 28 | 1.75 | Semi-Bold (600) | 1.3 | Sub-sections, card titles |
| H4 | 24 | 1.5 | Semi-Bold (600) | 1.35 | Grouping related content |
| H5 | 20 | 1.25 | Medium (500) | 1.4 | Minor headings, quotes |
| H6 | 16 | 1.0 | Bold (700) | 1.5 | Eyebrow text, tags, labels |
| Body Large | 18 | 1.125 | Regular (400) | 1.6 | Lead paragraphs |
| Body (p) | 16 | 1.0 | Regular (400) | 1.6 | Standard reading text |
| Small | 14 | 0.875 | Regular (400) | 1.5 | Footers, captions, tooltips |
| Micro | 12 | 0.75 | Medium (500) | 1.4 | Disclaimers, legal |

### 2.3 Typography rules **[CANON]**

- **12px is the absolute floor.** Montserrat's geometric forms break down below it.
- **Tight line height on headings** (1.1–1.2). Montserrat is wide; loose leading makes
  multi-line headers look disconnected.
- **Body text needs room** — 1.6 line height minimum.
- **H6 / eyebrow text is uppercase** with `letter-spacing: 0.05em`. Montserrat is sharp
  in uppercase; this is a signature look.
- **Negative tracking on large type.** Print specs are 130pt/−30 and 45pt/−20 tracking.
  Web equivalent: `letter-spacing: -0.02em` on Display/H1, `-0.015em` on H2/H3.
- **Text colour:** Dark Grey by default. White on images and dark backgrounds. Red Poppy
  for highlights and select headers only.
- **Two weights per heading, not all-bold.** The correct pattern is Medium + Light in one
  heading, emphasising the *meaningful* word. "How agile is your organisation?" — bold
  **agile**, not "is your". If a title doesn't need two weights, use Light throughout.
  **Never set an entire heading in Bold.**
- **Never use drop shadows on text.**
- Leading and tracking must be neither too tight nor too open — both are called out as
  errors.

> **Conflict, resolved.** Print guidance says body copy is Montserrat **Light (300)**;
> the web scale table says body is **Regular (400)**. For screen, follow the web scale
> table — 400 for body. Reserve 300 for large display type where Light reads elegantly.

### 2.4 Hyperlinks **[CANON + accessibility overlay]**

- Colour: Red Poppy → use `--dv-poppy-ink` `#d6334a` at body sizes (see §1.4).
- **Always underlined.**
- Weight: Medium (500) when body copy is Light; Bold (700) when body copy is Regular.
  Since web body is Regular, **links are 700** — but 500 is acceptable in dense UI where
  700 is too loud.

### 2.5 Tagline **[CANON]**

Text: **"AI-driven tech consulting"**

- Preferred colour: Red Poppy. Fall back to white or dark grey if legibility suffers.
- **Large format** (hero banners, page headers, splash): Montserrat **Light**, large size.
- **Small sign-off** (footers, sidebars, meta lines): Montserrat **Bold** for legibility.
- Position: typically at the end of the copy block.

---

## 3. Logo (web-relevant rules only)

**[CANON]**

- **Primary logo** = Red Poppy brandmark + **dark grey** wordmark. This is the default.
- On **dark backgrounds** use the white-wordmark version (poppy mark stays poppy).
- Use the **all-white** logo when the Red Poppy doesn't stand out enough.
- **Never use the wordmark alone.**
- **Brandmark alone** (the poppy) is allowed for: favicons and avatar/profile contexts
  where the word "Devoteam" already appears nearby. It does **not** replace the logo in
  the app header.
- **Clear space** = the height of the letter "d" on every side. Nothing encroaches.
- **Minimum size: 68px wide.**
- Never rotate, condense, expand, tint, add transparency, add a drop shadow, or otherwise
  alter it.
- **Correct pairings:** full-colour logo on white/light/secondary backgrounds; white logo
  on Red Poppy. **Never** the full-colour logo on Red Poppy, never a white logo on a
  secondary colour, never any logo on an accent colour, never the accent colour as the
  logo's colour.
- On imagery: full colour + white wordmark on dark images; full colour + grey wordmark on
  light images.

**Sub-branding:** do not create a logo for this app. If a lockup is needed it is
`Devoteam | AI Executive Office` — Devoteam always first, set in Montserrat and brand
colours. "Powered by Devoteam" and "by Devoteam" are both retired wordings — do not use
them anywhere in the UI or footer.

### 3.1 Available assets

The official logo pack is in [Assets/](../Assets/). **Use only the RGB SVGs on web** —
the CMYK, Pantone, EPS, AI and PDF files are print masters and must not be shipped.

| Variant | File | Contents | Use |
|---|---|---|---|
| Primary | `Copy of devoteam_rgb.svg` | `#3C3C3A` wordmark + `#F8485E` poppy | Default. Light backgrounds |
| White wordmark | `devoteam_rgb_white wordmark.svg` | white wordmark + `#F8485E` poppy | Dark backgrounds, dark images |
| All-white | `Copy of devoteam_rgb_white.svg` | fully white | Red Poppy backgrounds; when the poppy doesn't stand out |
| All-black | `Copy of devoteam_rgb_black.svg` | fully black | B&W printing only — avoid on screen |
| Brandmark | *derive — see below* | poppy only | Favicon, avatar contexts |

**Migration steps:**

1. Copy the four RGB SVGs into `public/images/logo/` with clean kebab-case names
   (`devoteam-primary.svg`, `devoteam-white-wordmark.svg`, `devoteam-white.svg`,
   `devoteam-black.svg`). Drop the "Copy of" prefixes and the space in the filename —
   spaces in asset paths cause avoidable URL-encoding bugs.
2. **Tighten the viewBox.** All four ship on a padded `0 0 595.3 248.1` canvas. Crop the
   viewBox to the artwork bounds, otherwise the 68px minimum-width rule and the
   "d"-height clear space both measure padding instead of the logo.
3. **Extract the brandmark.** In `Copy of devoteam_rgb.svg` the poppy is exactly two
   isolated paths — `.st1` (`#F8485E`) and `.st2` (`#FFFFFF`) — while the wordmark is the
   seven `.st0` paths. Pull `.st1` + `.st2` into a standalone square-viewBox SVG, then
   generate favicon sizes from it. Verify the crop visually before shipping; the
   proportions are our own and won't be pixel-identical to Devoteam's official export.
4. Retire [devoteam-logo.png](../Assets/devoteam-logo.png) — a PNG will not hold up at
   header sizes across device pixel ratios.

---

## 4. Shape system

### 4.1 Radius standards **[CANON]**

| Element | Radius |
|---|---|
| Cards, small elements | **15px** |
| Hero / large glass elements | **25px** |
| Modals | **24px** |
| Labels / chips / badges | **12px** |
| Buttons | **12px** (see conflict note) |
| Tables | 15px on the outer container; **rows stay square inside** |

**Do not mix random radius values.** Consistency here is what makes the system read as
modern tech.

> **Conflict, resolved.** The rounded-corners page lists buttons at **60px** ("fully
> rounded only when explicitly required by layout logic"), while the components page
> specifies **12px** and explicitly says to *avoid overly rounded pill buttons*.
> **Use 12px as the default.** Reserve 60px pills for the narrow case where layout logic
> demands it (e.g. a floating action chip), and never mix both styles on one screen.

### 4.2 Cards **[CANON]**

Cards are the primary content container in the system.

- Background: solid or glass
- Radius: **15px**
- Padding: **24–32px** (20px acceptable at the tight end for dense UI)
- Shadow: **soft, diffused, low elevation.** Never heavy.
- Content hierarchy: **title → description → action**
- Aligned on a grid, equal spacing between cards, never overlapping decorative elements.

Card backgrounds: Pure White (default) · Very light neutral tint, i.e. Light Grey
`#efeeee` (section differentiation) · Dark surface slightly elevated from the background
(dark mode).

**Avoid:** heavy gradients, background textures, decorative patterns.
→ The existing `.pattern-bg` geometric SVG texture in `globals.css` must be removed.

### 4.3 Bento grids **[CANON]**

Bento grid layouts are part of the new graphic system alongside neon, glass, and rounded
corners. Use them for dashboards and overview pages: mixed-size cards on a consistent
grid, uniform 15px radius, uniform gutters.

---

## 5. Glassmorphism

**[CANON]** — *"a premium accent, not a default."*

Glass must sit on a **visually rich or textured background** to work. On a flat white
page it does nothing.

**When to use:** hero sections · featured announcements · special content highlights.

**Universal rules:**
- **Do not stack.** Never layer glass on glass.
- **Backdrop blur: 12–16px.** Subtle. Over-frosting muddies the background.
- **Radius:** 15px for cards/small elements, **25px** for hero/large elements.
- **Transparency: 70–85% opacity** — legible text, background still reads through.
- **Verify 4.5:1 contrast** for text over the *combined* colour of glass fill + the
  image beneath it. This is an explicit brand requirement.

**Theme specifications:**

| Property | Light theme | Dark theme |
|---|---|---|
| Background fill | White @ **75%** opacity | Black @ **70%** opacity |
| Border stroke (1px) | White @ **50%** opacity | White @ **15%** opacity |
| Backdrop blur | **12px** | **16px** |
| Drop shadow | Soft & light | Deep & pronounced |

*(The source PDF's table mislabels both columns "Light Theme"; the second column is the
dark theme — confirmed by the fill values.)*

```css
.dv-glass {
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.50);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: var(--dv-radius-card);          /* 25px on hero */
  box-shadow: 0 4px 16px rgba(60, 60, 58, 0.10);
}

[data-theme='dark'] .dv-glass {
  background: rgba(0, 0, 0, 0.70);
  border-color: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}

/* Fallback: backdrop-filter is widely supported but degrade gracefully. */
@supports not (backdrop-filter: blur(12px)) {
  .dv-glass { background: rgba(255, 255, 255, 0.92); }
  [data-theme='dark'] .dv-glass { background: rgba(20, 20, 19, 0.92); }
}
```

---

## 6. Neon light trail — the brand differentiator

**[CANON]**

The neon light trail is Devoteam's **signature element**. It is "the emotional and
futuristic accent of the brand" — it signals innovation and energy.

**Purpose:** highlight key actions · emphasise CTAs · create visual tension in hero areas.

**Rule 1 — accent only.** Neon must never dominate a layout.
- ✓ CTA buttons · underlines for emphasis · subtle glow around key numbers or words
- ✗ large neon backgrounds · full neon text blocks · multiple competing neon colours in
  one layout

**Rule 2 — glow control.**
- Soft and diffused. **No hard outer glows.**
- Controlled opacity.
- **Never exceed 1–2 neon focal points per screen.**

**Rule 3 — contrast.**
- Neon works on dark backgrounds and deep neutral surfaces.
- Avoid neon on white unless very carefully controlled.

**Implementation** **[DERIVED]** — the guidelines publish no neon hex; build the glow
from Red Poppy so it stays on-palette:

```css
:root {
  --dv-neon: #f8485e;
  --dv-neon-glow-soft: 0 0 24px rgba(248, 72, 94, 0.35),
                       0 0 48px rgba(248, 72, 94, 0.18);
  --dv-neon-underline: linear-gradient(90deg,
                        rgba(248,72,94,0) 0%,
                        rgba(248,72,94,1) 20%,
                        rgba(248,72,94,1) 80%,
                        rgba(248,72,94,0) 100%);
}
```

Actual light-trail **imagery** (the flowing trail overlaid on photography) is a produced
asset — source it from the Branding Zone / the "neon light Gem" rather than hand-rolling
it in CSS. CSS neon is for glows, underlines, and button treatments only.

---

## 7. Components

### 7.1 Buttons **[CANON]**

**Primary**
- Solid brand primary fill
- **12px radius**
- **Medium (500)** weight text
- Optional **subtle** neon glow — **hero context only**

**Secondary**
- Outline style, **1px stroke**
- **No glow**

**Avoid:** overly rounded pill buttons · multiple competing button styles in one view ·
drop shadows on every button.

Accessible implementation (see §1.4 — a white label on `#f8485e` is only 3.46:1):

```css
.dv-btn-primary {
  background: var(--dv-poppy-ink);   /* #d6334a — 4.74:1 with white label */
  color: #ffffff;
  border-radius: 12px;
  font-weight: 500;
  padding: 12px 24px;
}
.dv-btn-primary:hover { background: #bd2c41; }

/* Hero CTA: label is ≥18.66px bold or ≥24px, so canon poppy passes at 3:1. */
.dv-btn-hero {
  background: var(--dv-poppy);       /* #f8485e */
  color: #ffffff;
  font-size: 1.25rem;
  border-radius: 12px;
  box-shadow: var(--dv-neon-glow-soft);
}

.dv-btn-secondary {
  background: transparent;
  color: var(--dv-poppy-ink);
  border: 1px solid var(--dv-poppy-ink);
  border-radius: 12px;
  font-weight: 500;
}
```

### 7.2 Labels / chips **[CANON]**

Purpose: categorisation and status indicators.

- **12px radius**, small and compact
- Brand primary or neutral tones only
- Text **always uppercase or small caps**
- **No shadows**
- ✓ "NEW", "AI INSIGHT", "EVENT" · ✗ decorative gradients, neon labels (unless in hero)

### 7.3 Icons **[CANON]**

- Colours: **Dark Grey (preferred)**, Red Poppy, or White (for contrast on images/dark).
- **No filled circles behind icons.** Keep it simple.
- Use **sparingly** — only to emphasise a message or aid comprehension. Icons should
  enhance, not overwhelm.
- The guidelines point to a Branding Zone icon set.

**Decision: use Lucide, self-hosted.** **[DERIVED]** The Branding Zone set is a *marketing*
icon library; this app uses **86 distinct glyphs** (`fa-brain`, `fa-calendar-week`,
`fa-angle-double-left`, …), which a marketing set will not cover. Lucide's clean geometric
strokes pair naturally with Montserrat and satisfy every canon icon rule — brand colours,
consistent stroke weight, no circular backings.

- Replace the Font Awesome CDN link in `globals.css` and `index.html` with self-hosted
  Lucide. This also removes the `@font-face` override hack currently patching Font
  Awesome's `font-display`.
- Map all 86 glyphs; audit for any Lucide equivalent that changes meaning.
- Stroke colour: `currentColor`, inheriting Dark Grey by default.
- Reserve Branding Zone icons for marketing/feature surfaces if they are ever added.

### 7.4 Arrows **[CANON]**

- Minimalist, consistent stroke weight
- Brand neutral or primary colour
- Never decorative or 3D
- Uses: navigation cues, carousel indicators, "Learn more" prompts
- Avoid thick playful arrows or mixed arrow styles in one layout

### 7.5 Modals **[CANON]**

- **24px radius**
- Stronger elevation than cards

### 7.6 Tables **[CANON]**

- **15px** outer container radius
- **Rows remain square** inside the container
- Optional subtle row hover state

---

## 8. Imagery

**[CANON]**

Three image categories:

**Super images** — high-impact brand assets: digital backgrounds, hero covers, posters.
Vibrant, conceptual, built around **interesting real-world light sources**. Warm, soft
tones. Used alongside logo and tagline. Not topic-specific.
✗ Too dark, removed from the real world, or a light source used as a repeating *pattern*.

**Subject-specific images** — for topic pages (AI, cybersecurity, data, cloud, business
automation, etc.). Colourful, optimistic, energetic. Real or conceptual but **always with
some form of light source.** Crop with room to breathe alongside text.

**People photography** — employees, clients, industry. **Authenticity is key**: people in
their natural environment, reportage style, never staged-looking.
- **Always full colour.** Never black and white portraits of Devoteamers.
- **Full bleed where possible.**
- **Never crop team photos into circles.**

Practical: use these as the "visually rich background" that glass elements require, and
as the dark surface neon needs.

### 8.1 Shipping without brand photography **[DERIVED]**

The Branding Zone image library (super images, light-trail assets) is not in this repo.
Glass and neon still ship — **build hero surfaces on the derived dark surfaces**
(`--dv-surface-base` `#141413` over `--dv-surface-1` `#1e1e1d`) with a soft neon glow
supplying the visual richness instead of photography.

This is fully on-brand: the guidelines state neon performs best on "dark backgrounds and
deep neutral surfaces", and dark-theme glass is specified against exactly this kind of
surface. Structure hero sections so a background image can be dropped in behind the glass
layer later **without reworking the component** — the glass layer should not assume a
solid fill beneath it.

---

## 9. Motion **[DERIVED]**

The guidelines don't specify motion, but the brand positions itself as "as dynamic as the
speed of AI". The app's existing motion tokens are on-brand — keep them:

- Fast 160ms · Base 300ms · Slow 520ms
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out), `cubic-bezier(0.22, 1, 0.36, 1)` (soft)
- Soft fade + rise entrances, staggered for lists
- Keep the `prefers-reduced-motion` block in `globals.css` intact — it is required.

Neon glows may pulse **subtly** or not at all; a hard blinking neon violates "soft and
diffused".

---

## 10. Token migration map

The app's current tokens live in [src/app/globals.css](../src/app/globals.css). Replace
the palette in place — the token *names* are used across every CSS module, so keeping the
existing names and swapping the values is the lowest-risk path. Add the `--dv-*` tokens
alongside for new brand-specific work.

| Current token | Current (HRSD) | New (Devoteam) | Note |
|---|---|---|---|
| `--color-ink` | `#161616` | `#3c3c3a` | Black → Dark Grey. **Black text is banned.** |
| `--color-ink-soft` | `#2e2e2e` | `#55554f` | |
| `--color-ink-muted` | `#5a5a5a` | `#6e6e68` | |
| `--color-ink-faint` | `#8a8a8a` | `#9a9a94` | |
| `--color-sand` | `#ffffff` | `#ffffff` | unchanged |
| `--color-sand-warm` | `#ffffff` | `#ffffff` | unchanged |
| `--color-sand-deep` | `#f7f7f7` | `#efeeee` | → Light Grey |
| `--color-sand-border` | `#e6e6e6` | `#e2e1e1` | |
| `--color-teal` | `#0E412A` | `#d6334a` | Brand primary → poppy (text-safe) |
| `--color-teal-hover` | `#0B3522` | `#bd2c41` | |
| `--color-teal-dark` | `#082A1B` | `#a5253a` | |
| `--color-teal-tint` | `rgba(14,65,42,.10)` | `rgba(248,72,94,.10)` | |
| `--color-teal-glow` | `rgba(14,65,42,.20)` | `rgba(248,72,94,.28)` | now the neon glow |
| `--color-gold` | `#c5a059` | `#fcc354` | → Intense Fire |
| `--color-gold-light` | `rgba(197,160,89,.15)` | `rgba(252,195,84,.18)` | |
| `--color-header-bg` | `#0E412A` | `#3c3c3a` | Dark Grey header, poppy logo mark |
| `--color-header-text` | `#ffffff` | `#ffffff` | unchanged |
| `--color-nav-bg` | `#0E412A` | `#3c3c3a` | |
| `--color-success` | `#4caf7d` | `#5ab891` | → Fresh Mint |
| `--color-success-text` | `#15803d` | `#2f7d5c` | |
| `--color-error` | `#d95f5f` | `#c02638` | deeper than brand poppy — see §1.5 |
| `--color-error-text` | `#c0392b` | `#c02638` | |
| `--radius-sm` | `6px` | `12px` | labels, buttons |
| `--radius-md` | `12px` | `15px` | **house radius** — cards |
| `--radius-lg` | `20px` | `24px` | modals |
| `--radius-xl` | `28px` | `25px` | hero / large glass |
| `--radius-full` | `9999px` | `9999px` | keep, but use rarely (§4.1 conflict note) |
| `body` font | `'saud', Arial` | `'Montserrat', 'Helvetica Neue', Arial` | also `button`, `input, textarea, select` |
| `::selection` bg | `rgba(197,160,89,.28)` | `rgba(248,72,94,.20)` | |
| `.pattern-bg` | gold SVG texture | **delete** | textures/patterns banned on cards |
| `--scrollbar-thumb` | `#e5e7eb` | `#e2e1e1` | |
| `--scrollbar-track` | `#f9fafb` | `#f7f7f6` | |

**Type scale.** The existing `--text-*` scale (11–38px) does not match the brand web
scale and its floor of 11px violates the 12px minimum. Replace with:

```css
--text-micro: 0.75rem;   /* 12px — floor */
--text-sm:    0.875rem;  /* 14px */
--text-base:  1rem;      /* 16px */
--text-lg:    1.125rem;  /* 18px */
--text-h5:    1.25rem;   /* 20px */
--text-h4:    1.5rem;    /* 24px */
--text-h3:    1.75rem;   /* 28px */
--text-h2:    2.25rem;   /* 36px */
--text-h1:    3rem;      /* 48px */
--text-hero:  4rem;      /* 64px */
```

Audit every `--text-xs` usage (11px) and promote it to `--text-micro` (12px).

### 10.1 Drop-in token block

Add this block to `:root` in `globals.css` alongside the remapped tokens:

```css
:root {
  /* ── Devoteam primary ── */
  --dv-poppy:          #f8485e;  /* canon — fills, large text, glows, icons */
  --dv-poppy-ink:      #d6334a;  /* text-safe poppy, 4.74:1 on white */
  --dv-poppy-light:    #fca2ae;
  --dv-poppy-lighter:  #fddade;
  --dv-grey:           #3c3c3a;  /* all body text */
  --dv-grey-light:     #efeeee;
  --dv-white:          #ffffff;

  /* ── Secondary (backgrounds & graphics only — never text) ── */
  --dv-intense-fire:   #fcc354;
  --dv-fresh-mint:     #5ab891;
  --dv-aqua:           #d7ebe7;
  --dv-beige:          #efeadc;

  /* ── Accent (data viz only) ── */
  --dv-blue-lagoon:    #4a8cca;
  --dv-candy:          #ec86a3;
  --dv-violet:         #63238c;

  /* ── Radius ── */
  --dv-radius-label:   12px;
  --dv-radius-button:  12px;
  --dv-radius-card:    15px;
  --dv-radius-modal:   24px;
  --dv-radius-hero:    25px;

  /* ── Glass ── */
  --dv-glass-fill:     rgba(255, 255, 255, 0.75);
  --dv-glass-border:   rgba(255, 255, 255, 0.50);
  --dv-glass-blur:     12px;

  /* ── Neon ── */
  --dv-neon:           #f8485e;
  --dv-neon-glow-soft: 0 0 24px rgba(248, 72, 94, 0.35),
                       0 0 48px rgba(248, 72, 94, 0.18);

  /* ── Dark surfaces (derived) ── */
  --dv-surface-base:   #141413;
  --dv-surface-1:      #1e1e1d;
  --dv-surface-2:      #2a2a28;
  --dv-surface-3:      #3c3c3a;
}
```

---

## 11. UI copy — tone of voice

Applies to every string in the interface: button labels, empty states, error messages,
tooltips, onboarding.

**Voice: "The Friendly Expert."** A helpful colleague, not a corporate brochure.

- **Real & honest** — hard data over vague promises. "35% cost reduction", not
  "maximised ROI".
- **Active & direct** — active voice 90% of the time. "Our team finished the project",
  not "tasks were completed".
- **You-centric** — minimise "we/us", prioritise "you". "From this article you will
  learn…", not "In this article we will explain…".
- **Plain English, British spelling** — short sentences, 15–20 words. "modernised the
  data centre", not "modernized the data center". *Exception:* official product names
  keep their native spelling (Unity Catalog stays Unity Catalog).
- **Empathetic and respectful of the reader's time.**

**Banned words** — the "No-Fly Zone":

| ✗ Stop saying | ✓ Start saying |
|---|---|
| Unlock, Empower, Transform | Specific actions: Migrate, Build, Code |
| Cutting-edge, Next-level | Specific tech: AWS, Kubernetes, Python |
| Seamless, Holistic | Specific processes: Automated, Integrated |
| Leverage, Utilise | Use |

**Structural rules:** lead with the hook · inverted pyramid (most important info first) ·
max one abstract concept per paragraph, immediately followed by a concrete example ·
scan-first design (bullets, bold headers, white space) · headings as a roadmap.

**EU AI Act:** any AI-generated photorealistic media in the product, and any chatbot
surface, requires visible labelling (e.g. "Generated with AI") under Article 50. This app
has a chat interface — it needs that disclosure.

---

## 12. Implementation checklist

### Typography

- [ ] Fetch Montserrat variable woff2 (300–800) → `public/fonts/`, keep `font-display: optional`
- [ ] Swap `'saud'` → `'Montserrat'` in `body`, `button`, `input, textarea, select`
- [ ] Delete `public/fonts/saud.woff2` and its `@font-face` block
- [ ] Replace `--text-*` scale; eliminate every sub-12px size (`--text-xs: 11px` violates the floor)

### Colour & tokens

- [ ] Apply the token migration map (§10) to `globals.css`
- [ ] Add the `--dv-*` token block (§10.1)
- [ ] Update `:focus-visible` outline colour from teal to `var(--dv-poppy-ink)`

### Shape & surfaces

- [ ] Delete `.pattern-bg` and any texture/gradient card backgrounds
- [ ] Normalise every radius to the 12/15/24/25 system; grep for stray `border-radius`
- [ ] Remove all circular backings behind icons and avatars

### Icons

- [ ] Remove the Font Awesome CDN `<link>` and the `@font-face` override in `globals.css`
- [ ] Install self-hosted Lucide; map all 86 glyphs (§7.3); verify no meaning drift
- [ ] Icons inherit `currentColor` → Dark Grey default, Poppy for emphasis

### Logo

- [ ] Copy the four RGB SVGs to `public/images/logo/`, kebab-case, no spaces (§3.1)
- [ ] Tighten each viewBox to the artwork bounds
- [ ] Extract the brandmark from `.st1` + `.st2`; generate favicons; verify crop visually
- [ ] Retire `devoteam-logo.png`; enforce 68px min width and "d"-height clear space

### Signature elements

- [ ] Apply glass **only** to hero and featured surfaces, never stacked, 12–16px blur
- [ ] Build heroes on dark surfaces + soft neon glow (§8.1); keep an image slot behind glass
- [ ] Add at most 1–2 neon focal points per screen
- [ ] Audit headings: two-weight emphasis, never all-bold, tight leading, no text shadows
- [ ] Add the tagline "AI-driven tech consulting" — Light in hero, Bold in footer sign-off
- [ ] Contrast-audit every text/background pair against 4.5:1 (3:1 for large text and UI)
- [ ] Sweep all UI strings for banned words and US spellings
- [ ] Add "Generated with AI" labelling on the chat surface (EU AI Act Art. 50)
- [ ] Verify `prefers-reduced-motion` block still functions after the rebrand

---

## Appendix — what was deliberately omitted

These sections of the brand guidelines are not web-design relevant and were skipped:
the One Devoteam logo *policy* rationale and the M&A / partnership / event lockup rules;
print specifications (CMYK, Pantone application, Adobe 5mm and Canva 25 corner settings);
PowerPoint and Google Slides template guidance; Canva and Google Vids asset libraries;
the Gemini Gems tooling (Slide Maker, Infographics Maker, Rewriter); the AI commercial
usage, licensing, and IP-ownership policy; email signatures, CVs, ebooks, one-pagers, and
physical merchandise; and company boilerplate, mission/vision/values narrative copy.
Pantone codes were retained in the colour tables purely as cross-reference for anyone
matching against print collateral.

Everything else in the PDF that touches screen design is captured above.
