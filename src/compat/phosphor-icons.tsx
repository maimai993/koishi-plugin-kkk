/**
 * `@phosphor-icons/react` 的替代实现。
 *
 * 为什么要替：这个包 **本身有 bug** —— 它的 package.json 是 `"type": "module"`，
 * 但 `exports.require` 指向 `./dist/index.cjs.js`（`.js` 在 ESM 包里会被当成 ESM ✗），
 * 于是模板一旦 `require` 它就抛：
 *   `exports is not defined in ES module scope ... @phosphor-icons/react/package.json contains "type": "module"`
 * 结果是**所有卡片模板都加载失败、退化成通用兜底卡**（用户看到的就是「模板怎么崩了」）。
 *
 * 这里接一层：用已经在依赖里的 `lucide-react`（CJS 正常 ✓）逐个映射成同名导出，
 * 调用方（模板）不用改任何代码，图标风格略有差异但卡片能正常渲染。
 */
export {
  Clock as ClockIcon,
  Image as ImageIcon,
  MapPin as MapPinIcon,
  Music as MusicNoteIcon,
  Play as PlayIcon,
  Play,
  CircleHelp as Question,
  UserPlus as UserPlusIcon,
  Users as UsersIcon,
  UsersRound as UsersThreeIcon,
  Video as VideoCameraIcon
} from 'lucide-react'
