# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Daily Focus는 하루 10~20개 수준의 개인 할 일을 기록·분류·추적하는 웹 앱이다. 별도 서버나 빌드 없이 브라우저에서 바로 열어 쓰고, 로그인하면 어느 기기에서든 같은 목록이 보이는 것을 목표로 한다. 상세 요구사항은 `할일관리앱_PRD.md` 참고.

현재 주력 버전은 `web_version/`이며, GitHub Pages(`gh-pages` 브랜치 루트)에 이 폴더의 3개 파일을 복사해 배포한다.

## 기술 제약

- 외부 라이브러리, 프레임워크, 빌드 도구를 절대 사용하지 않는다. (Supabase JS SDK도 쓰지 않는다)
- HTML5 + CSS3 + Vanilla JavaScript(ES6+)만 사용한다.
- 앱 파일은 `index.html`, `style.css`, `app.js` 3개로만 구성한다.
- `index.html`을 브라우저에서 더블클릭하면 별도 서버나 빌드 과정 없이 바로 실행되어야 한다.
- 데이터 저장은 Supabase(Auth + DB)를 `fetch`로 REST API를 직접 호출해서만 한다. localStorage는 기기별 캐시·화면 설정(필터, 테마)·로그인 토큰 보관용이다.
- DB 스키마와 RLS 정책은 `supabase/schema.sql`에서 관리한다. 사용자당 `todo_docs` 1행에 `{version, todos}` JSON 전체를 저장한다.
- `.github/workflows/supabase-keepalive.yml`이 3일마다 DB를 호출해 무료 프로젝트 일시정지(7일 미사용)를 막는다.

## 아키텍처 규칙

- 전역 상태는 `state` 객체 하나만 유지한다.
- 데이터 흐름은 항상 다음 순서를 따른다: 이벤트 → `state` 변경 → `saveState()` → `render()`.
- DOM은 부분 수정하지 않는다. 목록 영역은 상태가 바뀔 때마다 항상 통째로 재렌더링한다.
- 이벤트는 목록 컨테이너에 이벤트 위임 방식으로 한 번만 등록한다. 항목별로 개별 리스너를 달지 않는다.

## 보안 규칙

- 사용자 입력을 `innerHTML`로 삽입하지 않는다. 반드시 `textContent`를 사용해 XSS를 차단한다.
- `app.js`에는 Supabase anon(public) key만 넣는다. service_role key는 절대 코드나 저장소에 넣지 않는다.
- 사용자 간 데이터 분리는 RLS 정책(`auth.uid() = user_id`)이 책임진다. 테이블을 추가하면 반드시 RLS를 켠다.

## 코드 스타일

- 주석은 한국어로 작성한다.
- 함수는 하나의 일만 하도록 작게 유지한다.

## 커밋 메시지 규칙

형식: `타입: 한 줄 요약 (50자 이내)`. 필요할 때만 본문에 "왜 바꿨는지" 한두 줄을 덧붙인다.

타입은 다음 5가지만 사용한다.

| 타입 | 의미 |
|---|---|
| 추가 | 새 기능/파일 추가 |
| 수정 | 버그 고침 |
| 개선 | 기존 기능·디자인 손보기 (리팩터 포함) |
| 삭제 | 기능/파일 제거 |
| 문서 | md 문서만 변경 |

예시: `개선: 필터 버튼에 카테고리 색상 점 + 숫자 배지 추가`
