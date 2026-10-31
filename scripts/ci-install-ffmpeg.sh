#!/usr/bin/env bash
# CI 用：确保系统里有 ffmpeg / ffprobe。
# 为什么需要：真实渲染与音频时长测试（test/video-render.test.js、test/video-tts-audio.test.js）
# 会真的调用系统 ffmpeg/ffprobe；GitHub 的三个 runner 镜像默认都没有装，
# 不装就会在「检查与测试」这一步失败，进而整条 Release 流水线的安装包都产不出来。
# 已存在就直接返回；按平台安装；装不上就非零退出，让问题暴露在日志里而不是静默跳过。
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

if have ffmpeg && have ffprobe; then
  echo "ffmpeg 已存在：$(ffmpeg -version | head -n1)"
  exit 0
fi

case "$(uname -s)" in
  Linux)
    sudo apt-get update -q
    sudo apt-get install -y -q ffmpeg
    ;;
  Darwin)
    brew install ffmpeg
    ;;
  MINGW*|MSYS*|CYGWIN*)
    choco install ffmpeg -y --no-progress
    ;;
  *)
    echo "未知平台，请手动安装 ffmpeg/ffprobe" >&2
    exit 1
    ;;
esac

have ffmpeg || { echo "安装后仍找不到 ffmpeg" >&2; exit 1; }
have ffprobe || { echo "安装后仍找不到 ffprobe" >&2; exit 1; }
echo "安装完成：$(ffmpeg -version | head -n1)"