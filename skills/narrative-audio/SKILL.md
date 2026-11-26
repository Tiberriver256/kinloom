---
name: narrative-audio
description: Turn Kinloom narrative biographies (data/narratives.yaml) into narrated MP3 audio with Gemini text-to-speech via the bundled uv-based `narrative-audio` CLI. Covers writing a spoken script by hand (citations removed, dates and colonial money said aloud, editor notes split out from the story), IPA pronunciation files for hard surnames and places, synthesis with a story voice and a separate editor's-notes voice, and transcript QA. Use when the user wants audio, narration, an audiobook, a podcast-style reading, or text-to-speech for a family biography or narrative.
---

# Narrative audio

This skill comes with a standalone Python CLI, `skills/narrative-audio/scripts/narrative-audio`.
It uses a PEP 723 `#!/usr/bin/env -S uv run --script` shebang and declares its own
dependencies (`click`, `httpx`, `pyyaml`). It needs `ffmpeg` on PATH. Only the commands
that call the API (`synth`, and `transcribe`, which is optional) need a Gemini API key.

## Workflow

Writing the script and choosing pronunciations is **model work done by an agent, not API
calls**. Only the speech itself is paid for.

```bash
CLI=skills/narrative-audio/scripts/narrative-audio
ARCHIVE=path/to/archive            # a Kinloom archive with data/narratives.yaml

# 1. Pick a narrative (free). Shortest first is a good way to try things out.
$CLI list $ARCHIVE/data/narratives.yaml
$CLI extract $ARCHIVE/data/narratives.yaml <narrative-id> > /tmp/source.txt

# 2. Write <slug>.script.txt and <slug>.names.json by hand, following
#    references/script-rules.md. For batches, give each narrative to its own subagent.

# 3. Lint (free). Fix everything it reports before paying for speech.
$CLI check audio/<slug>.script.txt --names audio/<slug>.names.json
$CLI synth audio/<slug>.script.txt --names audio/<slug>.names.json --dry-run   # exact text sent

# 4. Synthesize (paid) — defaults to Google Cloud TTS Chirp 3: HD
$CLI synth audio/<slug>.script.txt --names audio/<slug>.names.json -o audio/<slug>.mp3

# Switch backends or voices via flags (or NARRATIVE_AUDIO_BACKEND=chirp3-hd|gemini):
$CLI synth audio/<slug>.script.txt --names audio/<slug>.names.json --backend chirp3-hd --gcp-project <project> -o audio/<slug>.mp3
$CLI synth audio/<slug>.script.txt --names audio/<slug>.names.json --backend gemini --model gemini-3.8-flash-tts -o audio/<slug>.mp3

# 5. Optional QA transcript (paid; costs about as much as a short text call)
$CLI transcribe audio/<slug>.mp3
```

`synth` supports two configurable TTS backends (`--backend` or `NARRATIVE_AUDIO_BACKEND`):

1. **`chirp3-hd` (default):** Google Cloud Text-to-Speech API (`texttospeech.googleapis.com`) using Chirp 3: HD voices (`en-US-Chirp3-HD-Charon` / `Kore`, configurable via `--language-code`, `--voice`, `--notes-voice`). Passes `.names.json` as structured `customPronunciations` (`PHONETIC_ENCODING_IPA`) without mutating the prose, automatically splits long sections under the 5,000-byte limit, and authenticates via `gcloud auth print-access-token` (with `--gcp-project` / `GOOGLE_CLOUD_PROJECT`) or `GOOGLE_CLOUD_TTS_API_KEY` / `--key-file`.
2. **`gemini`:** Gemini TTS (`gemini-3.8-flash-tts`) via `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `--key-file`, swapping each name in `.names.json` for its inline `/IPA/` string (longest names first, whole words only).

In both backends, `synth`:
1. Rewrites any leftover dates like "9 May 1766" as "May ninth, 1766".
2. Sends each `## ` section in the story voice (default `Charon`).
3. Sends every editor note as an "Editor's notes." segment in a second voice (default `Kore`), after a 2-second pause.
4. Strips RIFF/WAV headers, joins the PCM chunks losslessly, encodes one MP3, and prints a ready-to-paste `extensions.narrative_audio` YAML snippet (`duration_seconds` and `editor_notes_start_seconds`) for Kinloom's `createNarrativeAudioPlugin()`.

## Script rules (summary)

The full rules, with examples, are in `references/script-rules.md`. Load them before
writing a script.

- **Story vs editor notes:** research commentary goes under `# EDITOR'S NOTES` at the
  end. That means corrections of other researchers or legends, proof reasoning, identity
  mix-ups, unproved attributions, and names the records don't support. The story itself
  states only what happened.
- **Citations:** remove them entirely. That covers Lib./DB/Vol./page references,
  author-year citations and record IDs.
- **Spoken forms:** "May ninth, 1766", not "9 May 1766"; "1728 or 1732"; "682 pounds,
  5 shillings, and 2 pence", not "£682.5.2"; spell out abbreviations.
- **Accuracy:** add no facts. Every fact except citations ends up in either the story or
  a note.
- **Names file:** General American IPA in slashes for hard proper names and legal terms.

## Lessons learned (verified live, 2026-11)

- **Style directions get read aloud.** Text like "Read this warmly…" in the prompt is
  spoken word for word, at the start of every section. Send only the words to speak. The
  TTS models reject `systemInstruction` with HTTP 400 "Developer instruction is not
  enabled for this model".
- **Responses are `audio/wav`.** If you join chunks as raw PCM without stripping each
  RIFF header, the joins play as a short burst of noise (a transcriber heard it as
  "[applause]").
- **£ is read as "lb".** For example, "£682.5.2" came out as "682.5 lb and 2 pence".
  Write the money out in full.
- **Dates:** "9 May" can come out as "nine May". Write ordinals ("May ninth").
- **Inline IPA in slashes works well for names.** The voice pronounces it rather than
  reading the symbols out, and the audio length stays the same. Plain-English respellings
  ("Dool-hah-gen") are less dependable.
- **Don't repeat the title.** If the script already opens with it, don't add it again.
- **Retries fix glitches.** An occasional word comes out garbled (for example
  "contrary"). Generating that section again usually fixes it.
- **Speed and cost:** about 2× faster than real time, roughly 25 audio tokens per second
  of speech. A 700-word biography comes to about 5–6 minutes of audio and about 10–15k
  tokens.

## API key

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), or pass `--key-file`. If you use Google
Cloud, you can read an existing Generative Language key with
`gcloud services api-keys list --project <project>` and then
`gcloud services api-keys get-key-string <uid> --project <project>`. Save it to a file
that only you can read (mode 0600), and never commit it.

## Privacy

Don't narrate living people for anything shared or public. Kinloom's public builds
redact living individuals, and audio has to respect that too. Keep generated audio,
scripts and names files in the archive's own (private) repository, not in this public
repo.
