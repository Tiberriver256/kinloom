import type { EmbeddedGuide } from '../types.js';
import { NARRATIVE_AUDIO_SCRIPT_RULES } from './narrative-audio-script-rules.js';

export const NARRATIVE_AUDIO_GUIDE: EmbeddedGuide = {
  id: 'narrative-audio',
  command: 'narrative-audio',
  category: 'media-ocr',
  summary:
    'Turn Kinloom narratives into narrated MP3 audio (Chirp 3: HD, Gemini TTS, or OpenAI-compatible GPU TTS)',
  body: `# Narrative audio (\`kinloom narrative-audio\`)

Turn Kinloom narrative biographies (\`data/narratives.yaml\`) into narrated MP3 audio using Google Cloud TTS Chirp 3: HD (default), Gemini TTS, or an OpenAI-compatible \`/v1/audio/speech\` GPU server (such as SGLang-Omni + \`fishaudio/drama-3\` on Google Colab G4) via \`kinloom narrative-audio\`. Requires \`ffmpeg\` on \`PATH\`. Only \`synth\`, live \`batch\`, and the optional \`transcribe\` command call TTS or Gemini APIs.

## Workflow

Writing the script and choosing pronunciations is **model work done by an agent, not API calls**. Only the speech itself is paid for.

\`\`\`bash
ARCHIVE=path/to/archive            # a Kinloom archive with data/narratives.yaml

# 1. Pick a narrative (free). Shortest first is a good way to try things out.
kinloom narrative-audio list "$ARCHIVE/data/narratives.yaml"
kinloom narrative-audio extract "$ARCHIVE/data/narratives.yaml" <narrative-id> > /tmp/source.txt

# 2. Check existing Pronunciation Lexicon entries and verified IPA before authoring
#    <slug>.script.txt and <slug>.names.json (see \`kinloom guide narrative-audio/script-rules\`).
kinloom pronounce lookup <surname-or-place> --json

# 3. Lint (free). Fix everything it reports before paying for speech.
kinloom narrative-audio check audio/<slug>.script.txt --names audio/<slug>.names.json
kinloom narrative-audio synth audio/<slug>.script.txt --names audio/<slug>.names.json --dry-run

# 4. Synthesize (paid) — defaults to Google Cloud TTS Chirp 3: HD (\`--backend chirp3-hd\`)
kinloom narrative-audio synth audio/<slug>.script.txt --names audio/<slug>.names.json -o audio/<slug>.mp3

# Switch backends or voices via flags (or NARRATIVE_AUDIO_BACKEND=chirp3-hd|gemini|openai-speech):
kinloom narrative-audio synth audio/<slug>.script.txt --names audio/<slug>.names.json --backend chirp3-hd --gcp-project <project> -o audio/<slug>.mp3
kinloom narrative-audio synth audio/<slug>.script.txt --names audio/<slug>.names.json --backend gemini --model gemini-3.8-flash-tts -o audio/<slug>.mp3
kinloom narrative-audio synth audio/<slug>.script.txt --names audio/<slug>.names.json --backend openai-speech --endpoint http://127.0.0.1:8000 --model fishaudio/drama-3 --phoneme-mode ipa -o audio/<slug>.mp3

# Batch-narrate all missing deceased biographies (live or via Colab export/import manifest):
kinloom narrative-audio batch --repo "$ARCHIVE" --backend openai-speech --export-manifest /tmp/narratives-manifest.json
kinloom narrative-audio batch --repo "$ARCHIVE" --import-dir /tmp/rendered-narratives

# 5. Optional QA transcript (paid; uses Gemini API)
kinloom narrative-audio transcribe audio/<slug>.mp3

# 6. Upload rendered MP3 files during Archive Sync
kinloom sync --upload-media audio/<slug>.mp3 --verify-live
\`\`\`

\`synth\` and \`batch\` support three configurable TTS backends (\`--backend\` or \`NARRATIVE_AUDIO_BACKEND\`):

1. **\`chirp3-hd\` (default):** Google Cloud Text-to-Speech API (\`texttospeech.googleapis.com\`) using Chirp 3: HD voices (\`en-US-Chirp3-HD-Charon\` / \`Kore\`, configurable via \`--language-code\`, \`--voice\`, \`--notes-voice\`). Passes \`.names.json\` as structured \`customPronunciations\` (\`PHONETIC_ENCODING_IPA\`) without mutating the prose, automatically splits long sections under the 5,000-byte limit, and authenticates via \`gcloud auth print-access-token\` (with \`--gcp-project\` / \`GOOGLE_CLOUD_PROJECT\`) or \`GOOGLE_CLOUD_TTS_API_KEY\` / \`--key-file\`.
2. **\`gemini\`:** Gemini TTS (\`gemini-3.8-flash-tts\`) via \`GEMINI_API_KEY\` / \`GOOGLE_API_KEY\` / \`--key-file\`, swapping each name in \`.names.json\` for its inline \`/IPA/\` string (longest names first, whole words only).
3. **\`openai-speech\`:** Generic OpenAI-compatible \`POST <endpoint>/v1/audio/speech\` client (default model \`fishaudio/drama-3\`, configurable via \`--endpoint\` / \`KINLOOM_TTS_ENDPOINT\` / \`NARRATIVE_AUDIO_ENDPOINT\` and optional \`OPENAI_SPEECH_API_KEY\`). Supports \`--phoneme-mode ipa|arpabet|plain\` (\`<|phoneme_start|>...<|phoneme_end|>\`) and optional zero-shot voice cloning references (\`--story-ref-audio\` / \`--story-ref-text\`, \`--notes-ref-audio\` / \`--notes-ref-text\`). Never sends \`seed\` in request JSON for SGLang-Omni compatibility. See \`docs/colab-gpu-tts.md\`.

In both backends, \`synth\`:
1. Rewrites any leftover dates like "9 May 1766" as "May ninth, 1766".
2. Sends each \`## \` section in the story voice (default \`Charon\`).
3. Sends every editor note as an "Editor's notes." segment in a second voice (default \`Kore\`), after a 2-second pause.
4. Strips RIFF/WAV headers, joins the PCM chunks losslessly, encodes one MP3, and prints a ready-to-paste \`extensions.narrative_audio\` YAML snippet (\`duration_seconds\` and \`editor_notes_start_seconds\`) for Kinloom's \`createNarrativeAudioPlugin()\`.

## Script rules (summary)

The full rules, with examples, are available via \`kinloom guide narrative-audio/script-rules\`. Read them before writing a script.

- **Story vs editor notes:** research commentary goes under \`# EDITOR'S NOTES\` at the end. That means corrections of other researchers or legends, proof reasoning, identity mix-ups, undocumented attributions, and names the records don't support. The story itself states only what happened.
- **Citations:** remove them entirely. That covers Lib./DB/Vol./page references, author-year citations and record IDs.
- **Spoken forms:** "May ninth, 1766", not "9 May 1766"; "1728 or 1732"; "682 pounds, 5 shillings, and 2 pence", not "£682.5.2"; spell out abbreviations.
- **Accuracy:** add no facts. Every fact except citations ends up in either the story or a note.
- **Names file:** General American IPA in slashes for hard proper names and legal terms. Check \`kinloom pronounce lookup <term>\` and the archive **Pronunciation Lexicon** first.

## Lessons learned (verified live, 2026-11)

- **Style directions get read aloud.** Text like "Read this warmly…" in the prompt is spoken word for word, at the start of every section. Send only the words to speak. The TTS models reject \`systemInstruction\` with HTTP 400 "Developer instruction is not enabled for this model".
- **Responses are \`audio/wav\`.** If you join chunks as raw PCM without stripping each RIFF header, the joins play as a short burst of noise (a transcriber heard it as "[applause]").
- **£ is read as "lb".** For example, "£682.5.2" came out as "682.5 lb and 2 pence". Write the money out in full.
- **Dates:** "9 May" can come out as "nine May". Write ordinals ("May ninth").
- **Comma-grouped numbers pause in Chirp 3: HD:** "Patent number 6,469" is spoken as "Patent number six [pause] four hundred sixty-nine" because Chirp treats the thousands comma as a clause break. Spell out comma-grouped numbers in words (and \`synth\`'s \`speak_numbers()\` preprocessor automatically expands any that slip through).
- **Inline IPA in slashes works well for names.** The voice pronounces it rather than reading the symbols out, and the audio length stays the same. Plain-English **Respellings** ("Dool-hah-gen") are less dependable.
- **Don't repeat the title.** If the script already opens with it, don't add it again.
- **Retries fix glitches.** An occasional word comes out garbled (for example "contrary"). Generating that section again usually fixes it.
- **Speed and cost:** about 2× faster than real time, roughly 25 audio tokens per second of speech. A 700-word biography comes to about 5–6 minutes of audio and about 10–15k tokens.

## Credentials and authentication

- **Default backend (\`chirp3-hd\`, Google Cloud Text-to-Speech):** Authenticate via \`gcloud auth print-access-token\` with \`GOOGLE_CLOUD_PROJECT\` (or \`--gcp-project\`), or set \`GOOGLE_CLOUD_TTS_API_KEY\` (or pass \`--key-file\`).
- **Gemini backend (\`--backend gemini\`) and \`transcribe\`:** Set \`GEMINI_API_KEY\` (or \`GOOGLE_API_KEY\`), or pass \`--key-file\`. Save any key file with mode \`0600\` and never commit it.

## Living Privacy Rule

Do not narrate **Living** people for anything shared or public. Kinloom's **Living Privacy Rule** redacts **Living** people in public **Archives**, and narrated audio must follow the same rule. Keep generated audio, scripts, and names files in the archive's own private repository, never in this public repo.`,
  subguides: {
    'script-rules': NARRATIVE_AUDIO_SCRIPT_RULES,
  },
};
