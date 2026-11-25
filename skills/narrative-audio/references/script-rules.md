# Spoken-script rules

Rules for turning one narrative (`title` and `body_md` from `data/narratives.yaml`) into a
script that a text-to-speech narrator reads aloud. Write it the way a person speaks, not the
way a page reads. All examples below are made up.

## Output format

Plain text, in exactly this shape:

```
<Spoken title line>

## <Section heading>
<story paragraphs>

## <Section heading>
<story paragraphs>

# EDITOR'S NOTES
- <note, one or two spoken sentences>
- <note>
```

Leave out `# EDITOR'S NOTES` only if the narrative has no research commentary. Don't add
any markdown beyond the `## ` and `# EDITOR'S NOTES` lines.

## Separate the story from the editor notes

The **story** is what happened in the person's life: births, marriages, children, land,
moves, church, work, money, death, and what the heirs did. Tell it plainly and
confidently, using the best-supported facts.

**Editor notes** are commentary on the research, not on the life:
- corrections of other researchers, family legends, online trees, indexes, memorial
  sites or lineage societies ("refuting the 1736 birth year in…", "contrary to the
  family legend…", "secondary claims place the marriage in…")
- proof reasoning ("this proves she was born after…", "establishing that…")
- identity mix-ups (another person with the same name, the wrong headstone)
- attributions that are unproved or disputed ("the militia service remains unproved")
- names that the records do not support (for example, a middle name invented online)
- the original record spelling of a name, if the story uses the modern spelling

Move each of these out of the story and into a note. Keep the best-supported fact in the
story and drop the argument. Example:

- Source: *"born between ca. 1740 and 3 March 1744 (the 1765 tax list rates him as an
  adult, refuting the 1748 birth year in an online tree)"*
- Story: "He was born between about 1740 and March third, 1744."
- Note: "A 1765 tax list rates him as an adult, which rules out the 1748 birth year given
  in an online tree."

Each note must make sense when heard without the story right before it.

## Remove citations completely

Remove archive, book and page references (Lib., DB, Vol., p./pp., Book N), author-year
citations ("Smith 1872, p. 771"), record IDs (film numbers, memorial numbers), and any
parenthetical that only cites a source. Don't move these into the notes either. The
written narrative already has them.

## Write it to be heard

| Written | Spoken |
|---|---|
| 9 May 1766 / May 9, 1766 | May ninth, 1766 |
| 17 September | September seventeenth |
| 1728/1732, 1724/5 | 1728 or 1732, 1724 or 1725 |
| (1691-1784) after a name | , who lived from 1691 to 1784, |
| £682.5.2 | 682 pounds, 5 shillings, and 2 pence |
| 1s. 5d. | one shilling and five pence |
| £470 | 470 pounds (otherwise TTS says "lb") |
| ca. / c. / b. / decd / Co. | circa or about / born / deceased / County |
| Jr. / Sr. / Capt. | Junior / Senior / Captain |
| 21+ / & | twenty-one or older / and |
| "Zero primary records…" | "No primary records…" |

- **Record spellings in quotes:** use the modern spelling of the name and state the
  fact directly. Don't put quotation marks around record wording.
- **Legal terms:** briefly explain an unusual term the first time it comes up ("died
  intestate, meaning without a will"). That's the only kind of addition allowed.

## Accuracy

Don't add, infer or embellish facts. Don't summarize anything substantive away: every fact
in the original (except citations) has to end up in either the story or a note. If a
sentence in the source is ambiguous, keep its ambiguity rather than resolving it, and
mention it when you report back.

## Pronunciation file (`<slug>.names.json`)

This is a JSON object. Each key is a proper name, or an unusual legal term, that a TTS
voice might mispronounce: Dutch, German, Huguenot or colonial surnames, unusual place
names, archaic legal words. Write each key exactly as it appears in the script. Each value
is the General American IPA pronunciation with stress marks, inside slashes:

```json
{
  "Vanderhoef": "/ˈvændərhuːf/",
  "Schoonmaker": "/ˈskuːnmeɪkər/",
  "Raritan": "/ˈrærɪtən/",
  "administratrix": "/ædˌmɪnɪˈstreɪtrɪks/"
}
```

Skip ordinary English names (John, Mary, Virginia, New Jersey). Use how descendants and
local people actually say a name, not the textbook form; if a pronunciation is uncertain,
say so when you report back. IPA in slashes works well: the TTS voice pronounces it
instead of reading the symbols out.
