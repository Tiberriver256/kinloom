# GPU TTS with Google Colab and OpenAI-Compatible Endpoints

Kinloom supports OpenAI-compatible `/v1/audio/speech` endpoints in both `kinloom pronounce synth` and `kinloom narrative-audio`. This lets an operator synthesize pronunciation clips and biography narrations on a Google Colab G4 GPU (for example running SGLang-Omni with `fishaudio/drama-3`), a local GPU server, or a cloud GPU host without bundling model weights inside Kinloom.

## Privacy Fence

Kinloom excludes living people before any text enters a TTS request or batch manifest.

- Both `kinloom pronounce synth` and `kinloom narrative-audio batch` evaluate every person through `resolveEffectiveLiving(person, config.privacy, referenceYear)` from `@kinloom/core`.
- `kinloom pronounce synth` rejects any archive that has a living-person pronunciation leak in `data/people.yaml` or `kinloom.config.yaml`.
- `kinloom narrative-audio batch` skips every narrative whose `subject_person_id` or `person_ids` references a living person.
- Keep all generated `.wav`, `.mp3`, and manifest files inside your private archive repository. Never commit private archive audio or names to this public repository.

## Compatibility Rules

- **Never send `seed` to SGLang-Omni.** Kinloom's OpenAI-compatible speech client omits `seed` from `/v1/audio/speech` payloads so SGLang-Omni accepts `fishaudio/drama-3` requests without HTTP 400 rejections.
- **Deterministic v2 pronunciation filenames.** `kinloom pronounce synth` computes the exact SHA-256 `v2` cache key used by `@kinloom/server` (`pronunciation-<sha256[:16]>.wav` or `.mp3`), preserving IPA case so clips uploaded to R2 hit server cache immediately.
- **Phoneme tag modes.** Pass `--phoneme-mode ipa` (default), `arpabet`, or `plain`. In `ipa` and `arpabet` modes, Kinloom wraps lexicon entries in `<|phoneme_start|>...<|phoneme_end|>` tags.

## Mode 1: Live HTTP Endpoint (`--backend openai-speech`)

Start an OpenAI-compatible `/v1/audio/speech` server (such as SGLang-Omni serving `fishaudio/drama-3` on a Colab G4 forwarded over SSH, or a local GPU server listening on port `8000`).

```bash
export KINLOOM_TTS_ENDPOINT="http://127.0.0.1:8000"
# Optional if your endpoint requires authentication:
# export OPENAI_SPEECH_API_KEY="your-token"

# 1. Batch-synthesize curated archive pronunciations (24 kHz mono, -16 LUFS)
kinloom pronounce synth \
  --repo /path/to/archive \
  --backend openai-speech \
  --model fishaudio/drama-3 \
  --phoneme-mode ipa \
  --format wav \
  --update-config

# 2. Synthesize one biography script with optional zero-shot voice cloning
kinloom narrative-audio synth audio/hendrik-van-der-meer.script.txt \
  --names audio/hendrik-van-der-meer.names.json \
  --backend openai-speech \
  --model fishaudio/drama-3 \
  --phoneme-mode ipa \
  --story-ref-audio refs/story-voice.wav \
  --story-ref-text "Sample transcript matching the story reference clip." \
  --notes-ref-audio refs/notes-voice.wav \
  --notes-ref-text "Sample transcript matching the notes reference clip." \
  -o media/audio-hendrik-van-der-meer.mp3

# 3. Batch-narrate all deceased biographies missing extensions.narrative_audio
kinloom narrative-audio batch \
  --repo /path/to/archive \
  --backend openai-speech \
  --model fishaudio/drama-3 \
  --update-yaml
```

## Mode 2: Portable Colab Batch Manifest (Export and Import)

Use manifest mode when direct HTTP tunneling is unavailable or when you run synthesis inside the Google Colab Web UI.

### Pronunciation Clips

```bash
# Export a strictly privacy-filtered manifest with exact v2 filenames
kinloom pronounce synth \
  --repo /path/to/archive \
  --backend openai-speech \
  --export-manifest /tmp/pronounce-manifest.json

# Run synthesis on Colab G4 (write each target.filename into ./rendered-pronunciations/)
# Then import the rendered clips into media/ and update kinloom.config.yaml:
kinloom pronounce synth \
  --repo /path/to/archive \
  --import-dir /tmp/rendered-pronunciations \
  --update-config
```

### Biography Narrations

```bash
# Export spoken scripts and chunk payloads for deceased biographies missing audio
kinloom narrative-audio batch \
  --repo /path/to/archive \
  --backend openai-speech \
  --export-manifest /tmp/narrative-manifest.json

# After Colab renders audio-<slug>.mp3 and optional manifest-results.json
# (containing duration_seconds and editor_notes_start_seconds), import back:
kinloom narrative-audio batch \
  --repo /path/to/archive \
  --import-dir /tmp/rendered-narratives
```

## Protecting Colab Compute Units

GPU runtimes continue consuming compute units while idle. Always terminate the runtime immediately after your batch finishes:

- From the Colab CLI: run `colab stop` after downloading your rendered audio directory.
- From a Colab notebook cell: add `from google.colab import runtime; runtime.unassign()` in the final cell after saving outputs to Google Drive or downloading the archive.
