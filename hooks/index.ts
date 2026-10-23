import type { Register } from 'claude-code'

import { registerCoordinate } from './coordinate/register'
import { registerTransprompt } from './transprompt/register'

// 플러그인 하나에 hooks 모듈은 하나뿐이다. mod를 늘릴 때는 hooks/<이름>/ 에 두고 여기서 부른다.
export const register: Register = (on, options) => {
  registerTransprompt(on, options)
  registerCoordinate(on, options)
}
