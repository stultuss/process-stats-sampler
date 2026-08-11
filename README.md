# process-stats-sampler

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI][ci-image]][ci-url]

从 Demo 项目的 `ShellTools.monitor` 抽出的进程采样逻辑，独立成库：把 Node.js 进程的内存与 CPU 使用情况写入 JSON 文件，并附带 Node 事件循环执行延迟测量。

## 安装

```bash
npm install process-stats-sampler
```

## 使用

```js
const {ProcessStatsSampler} = require('process-stats-sampler');

// 每 30 秒调用一次，采样结果写入 /tmp/stats.log
await ProcessStatsSampler.monitor('/tmp/stats.log', 30);
```

也可以使用便捷函数别名：

```js
const {monitor} = require('process-stats-sampler');

await monitor('/tmp/stats.log', 30);
```

## 延迟测量

```js
const {lag} = require('process-stats-sampler');

// 等待 1000ms，返回实际延迟与预期时间的差值（毫秒，>= 0）
const delay = await lag(1000);
```

`lag(ms = 1000)` 用于检测 Node 事件循环的执行延迟：事件循环被同步任务阻塞时，定时器会晚触发，实际经过时间与预期时间的差值即为返回的 `delay`。

## API

### `monitor(filename?, interval?, options?)`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `filename` | `string` | `/tmp/stats.log` | 输出 JSON 文件路径，目录不存在时自动创建；写入采用临时文件 + 原子替换 |
| `interval` | `number` | `30` | 采样间隔（秒），必须为正的有限数 |
| `options.logger` | `{warn: (message: string) => void}` | `console` | 采样失败时记录警告；缺少 `warn` 时自动降级到 `console` |
| `options.unit` | `'ratio' \| 'percent' \| 'machine-percent'` | `'ratio'` | CPU 输出单位 |
| `options.lag` | `boolean \| number` | `true` | 是否记录 lag（事件循环延迟探测）：`true` 用 1ms 探测，`false` 不探测（字段写 0），数字为自定义探测毫秒数 |

#### CPU 单位

- `ratio`（默认）：CPU 微秒 / 墙钟毫秒，单核满载约为 1000（与 Demo 行为一致）
- `percent`：单核百分比，单核满载为 100
- `machine-percent`：整机百分比（单核百分比 ÷ CPU 核数）

输出中的 `lag` 字段为事件循环执行延迟探测结果（与 `lag()` 同一语义）：每次采样等待一个短定时器，事件循环被同步任务阻塞时定时器晚触发，返回值即当前 Node 的执行延迟（毫秒，最小 0）。默认用 1ms 探测，可用 `options.lag` 关闭或自定义探测时长。

参数错误（`filename` 为空、`interval` 非正数、`unit` 非法、`lag` 非法、`ms` 非法）会抛出 `TypeError` / `RangeError`；文件读写等运行时错误仅记录警告，不会向调用方抛错。

### `lag(ms?)`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ms` | `number` | `1000` | 预期等待毫秒数，非负有限数，最大约 24.8 天 |

返回实际经过时间与 `ms` 的差值（毫秒，最小为 0）。

输出内容示例：

```json
{
  "rss": 41058304,
  "heapTotal": 16777216,
  "heapUsed": 8615928,
  "external": 863268,
  "arrayBuffers": 11358,
  "user": "0.25",
  "system": "0.06",
  "lag": 0
}
```

## 行为说明

- CPU 速率取两次采样之间的差值除以 `interval * 1000`；首次调用以当前 `cpuUsage()` 为基线，因此首次采样接近 0。
- `lag` 字段为事件循环执行延迟探测结果（见上文），可通过 `options.lag` 控制开关与探测时长。
- 并发调用在库内串行执行，避免 CPU 基线与文件写入互相干扰。
- 文件写入原子化（临时文件 + `rename`），进程中断不会留下截断的 JSON。
- `lag` 的定时器不调用 `unref`，因此进程内若只有未完成的 `lag` 定时器，进程会等它触发后才退出（保证 Promise 必定 resolve）。

## 开发

```bash
npm run build   # 编译到 dist/
npm test        # 构建 + 运行 node:test 测试
```
## License

[MIT](./LICENSE)

[npm-image]: https://img.shields.io/npm/v/process-stats-sampler.svg
[npm-url]: https://npmjs.org/package/process-stats-sampler
[downloads-image]: https://img.shields.io/npm/dm/process-stats-sampler.svg
[downloads-url]: https://npmjs.org/package/process-stats-sampler
[ci-image]: https://github.com/stultuss/process-stats-sampler/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/stultuss/process-stats-sampler/actions/workflows/ci.yml