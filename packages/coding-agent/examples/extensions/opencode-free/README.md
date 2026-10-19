# OpenCode CLI 무료 전용 확장

Senpi/OMO의 사용자 확장 예제예요. 코어 모델 목록이나 차단 정책을 변경하지 않고
OpenCode CLI를 별도 provider인 `opencode-free`로 등록해요.

허용하는 모델은 `opencode/deepseek-v4.1-flash-free` 하나뿐이에요. 매 실행에는
`--model opencode/deepseek-v4.1-flash-free --pure --format json`이 들어가요.
모델 탐색, 자동 로그인, 다른 모델로의 재시도나 폴백은 하지 않아요.
OpenCode에 사용자가 이미 설정한 인증을 CLI가 사용하며 확장은 인증 파일을 읽지 않아요.

## 사용

PATH에 `opencode`가 있고 해당 무료 모델을 사용할 수 있는 환경에서 명시적으로 로드해요.
이 예제를 추가하는 것만으로 활성 런타임이나 전역 설정이 바뀌지 않아요.

```sh
senpi -e ./packages/coding-agent/examples/extensions/opencode-free/index.ts \
  --provider opencode-free --model opencode/deepseek-v4.1-flash-free
```

각 요청은 새 임시 디렉터리에서 실행하고, OpenCode 자체 도구를 사용하지 않도록 안내해요.
Senpi 도구 정의와 대화는 프롬프트 인자로 보내요. 도구 요청은 엄격한
`SENPI_TOOL_CALLS` JSON 응답으로 받아 Senpi가 실행하게 해요.
텍스트 전용이며 이미지 입력을 지원하지 않아요. 응답은 CLI가 끝난 뒤 이벤트로 전달해요.
컨텍스트 128,000 / 출력 16,384는 보수적인 확장 메타데이터이며 서비스 한도를 보장하지 않아요.
토큰 수는 CLI 버전별 차이를 추측하지 않고 현재 0(미집계)으로 남겨요.

CLI·인증·네트워크·JSON·도구 프로토콜 오류는 실패로 끝내고 해당 확장 인스턴스를 잠가요.
호스트 세션도 중단하며 자동 폴백 대상으로 등록하지 않아요. 원인을 로컬에서 확인하고
명시적으로 확장을 다시 로드해야 새 요청을 보낼 수 있어요. 원시 CLI 오류는 인증 정보가
포함될 수 있어 그대로 출력하지 않아요. CLI가 보고한 비용이 0이 아니면 실패 처리해요.
이는 서비스 가격 정책에 대한 보장이 아니며, 이름이 비슷한 다른 무료 모델도 허용하지 않아요.

## 검증

```sh
bun test ./packages/coding-agent/examples/extensions/opencode-free/index.test.ts
```

테스트는 실제 자식 프로세스 경계에서 로컬 `opencode` fixture를 사용해요.
실제 서비스·로그인·인증·네트워크를 사용하지 않고 고정 플래그, 도구 전달,
비허용 모델 거부, 오류 후 추가 프로세스 금지와 취소를 검증해요.

PR #3120의 코어 모델 blocklist 구현과 별개이며, OMO #6823에서 보고한 직접 API 경로 대신
사용자가 확인한 CLI 경로를 제공해요. `luongnv89/pi-extensions/extensions/opencode-pi`는
설계 참고만 했어요. 해당 구현의 모델 탐색·기본 모델 폴백·환경변수 모델 교체는 가져오지 않았어요.
