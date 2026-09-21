# engine-patches —— 部署侧的引擎运行时补丁

引擎 checkout（现在是 `C:\Users\bestarc\Desktop\dsh-0.1.6`，以后是 `deepseek-harness`）保持与官方逐字一致；
这里放"只属于本部署"的运行时改动，由 `start-dsh-lan.cmd` 通过
`node --import .\register.mjs apps\cli\lib\bin.js ...` 加载。

| 补丁 | 作用 | 什么时候可以删 |
|---|---|---|
| `legacy-turn-restart.mjs` | v2→v3 会话迁移时补上 `legacyInterruptedTurnRestart`。少了这个标志，凡是有"某轮被打断、下一轮顶上来"历史形态的老会话全部打不开（0.1.6-alpha.2 的表现） | 上游把该标志补进 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 之后 |

## 验证

- 启动后 `~\.dsh\live-0.1.6.err.log` 里应有一行 `[dsh-lan] engine patch: legacy-turn-restart applied`。
- `~\.dsh\engine-patches\applied.log` 每次命中都会追加一行（含命中的模块路径）。
- 若日志出现 `engine patch FAILED: anchor missing`，说明上游改了那段代码的文本形态：老会话会重新打不开，需要更新本补丁的锚点。

## 纪律

1. **不要**为了修这个问题去改引擎目录里的任何文件；`git -C <engine> status` 必须始终是空的。
2. 补丁命中失败必须"大声失败"（打印到 stderr 并在启动日志可见），不许静默降级。
3. 补丁只做最小文本替换；出现第二个补丁时，优先考虑改成部署插件（`~\.dsh\plugins\`）而不是继续堆 loader hook。
