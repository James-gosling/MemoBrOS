#!/bin/sh
# Fetches what test/speech-real.test.js needs: the real Whisper archives and short Spanish/English recordings.
#   sh scripts/fetch-speech-fixtures.sh [folder]        (default: test/fixtures/speech, which Git ignores)
# Needs curl, and espeak-ng + sox for the recordings (sudo apt install espeak-ng sox). About 1 GB of downloads.
set -e
DIR="${1:-test/fixtures/speech}"
mkdir -p "$DIR/wav"
for m in tiny base small; do
  f="$DIR/sherpa-onnx-whisper-$m.tar.bz2"
  [ -s "$f" ] || curl -L --fail -o "$f" "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-$m.tar.bz2"
done
say() { espeak-ng -v "$1" -s 140 -w "$DIR/wav/raw.wav" "$3" && sox "$DIR/wav/raw.wav" -r 16000 -c 1 -b 16 "$DIR/wav/$2.wav"; }
say en-us en1 "Arvi, open Visual Studio Code"
say en-us en2 "Arvi, analyze my screen"
say es-419 es1 "Arvi, abre Visual Studio Code"
say es-419 es4 "Hoy vamos a revisar el estado del proyecto y despues preparamos el informe para el cliente"
rm -f "$DIR/wav/raw.wav"
echo "Fixtures ready in $DIR. Run: MEMOBROS_SPEECH_FIXTURES=$DIR npm run test:speech"
