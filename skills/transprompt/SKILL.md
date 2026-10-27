---
description: "음성 프롬프트 구조화: on | off | auto | review | status | why, 또는 바로 구조화할 내용"
argument-hint: "on | off | auto | review | status | why | [구조화할 내용]"
disable-model-invocation: true
---

이 스킬은 `/gudals:transprompt`를 명령 목록에 바로 띄우기 위한 자리입니다. 실행은 gudals 플러그인의 transprompt mod가 가로채서 처리하므로, 보통은 이 본문이 Claude에게 전달되지 않습니다.

이 본문을 읽고 있다면 transprompt mod가 로드되지 않은 것입니다. 사용자에게 그렇다고 짧게 알리고, `/plugin`의 Installed 탭에서 gudals 플러그인이 켜져 있는지, 그리고 `--safe-mode`나 `disableAllHooks`처럼 mod를 막는 설정이 있는지 확인해 보라고 안내하세요. 다른 작업은 하지 마세요.
