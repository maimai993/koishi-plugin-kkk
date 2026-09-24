import { defineTemplate } from '@karinjs/template-react'

import type { BilibiliInteractiveData } from './components/types'
import { BilibiliInteractive } from './components/interactive'

export default defineTemplate({
  name: '互动视频剧情图',
  description: 'B站互动视频的剧情分支与选项',
  component: BilibiliInteractive,
  validate: (data): data is BilibiliInteractiveData =>
    typeof data === 'object' &&
    data !== null &&
    typeof (data as any).title === 'string' &&
    ((data as any).graph !== undefined || Array.isArray((data as any).choices))
})
