---
name: media-context
description: Transcribe video/audio (calls, screen recordings, YouTube) locally into context/<category>/ so the agent can read spoken context it cannot otherwise reach. Use when the user shares a call recording, a video link, or asks to bring meeting context into a task.
---

# Media Context Pipeline

Transcribe local or remote audio/video into project context files (`context/product/` or `context/<category>/`).

## Pipeline

1. **Tool Check**: Ensure prerequisite CLI tools are available in the environment:
   - `yt-dlp` (for fetching remote media)
   - `ffmpeg` (for media processing/demuxing)
   - `faster-whisper` or `whisper` via Python

2. **Download / Extract Audio**:
   When given a URL, download the best audio stream:
   ```bash
   yt-dlp -f bestaudio -x --audio-format mp3 -o "tmp_audio.%(ext)s" "<URL>"
   ```

3. **Transcribe Locally**:
   Run transcription locally using `faster-whisper` (default model `small`, quantization `int8`, with VAD filtering):
   ```bash
   python -c 'from faster_whisper import WhisperModel; model = WhisperModel("small", device="cpu", compute_type="int8"); segments, _ = model.transcribe("tmp_audio.mp3", vad_filter=True); print("\n".join(s.text for s in segments))' > transcript.txt
   ```
   - Language: autodetected by default; pass explicit language (e.g. `--lang ru` or `language="ru"`) when specified.
   - Russian (RU) transcripts are fully supported.

4. **Output to Context**:
   - Save the generated transcript to `context/product/<name>.md` (or `context/<category>/<name>.md` if a specific category is requested).
   - Reference the resulting transcript file in the current task/plan for subsequent agent phases.
   - Remove temporary audio files after transcription.

## Fallbacks

- **No `yt-dlp`**: Request that the user download the audio/video file directly and place it in the workspace or `context/`.
- **No `whisper` / `faster-whisper`**: Ask the user to provide a manual transcript or text summary in `context/<category>/`.

## Privacy

- **Local-Only**: Transcription runs entirely on the local machine.
- **Zero Uploads**: Media files and raw audio are never transmitted to external APIs or remote third parties.
