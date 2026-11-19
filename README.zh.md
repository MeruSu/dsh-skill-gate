# dsh-skill-gate

**装上这个插件，什么都不会变。** 没有配置文件时，每个预设看到的技能目录和装之前一模一样——不配名单，它就是个空转的插件，而且对此一声不吭。

技能目录是 DSH 首轮请求里第二大的一块固定开销：实测 `dev` 预设 9,917 B / 38 条，占 40,250 B 首轮请求的 24.6%（`cangku/261119_k4m_skillgate_spec.md` §1）。而大多数预设真正用得上的只有几条。`dsh-skill-gate` 让你**按预设**决定哪些技能值得露出来：被隐藏的技能既不进模型上下文，模型想调也调不动。

名单是你自己的事。插件不预置任何名单，省下的字节只在你写完名单之后才存在。

> **状态：0.1.3——已在真实 desktop profile 上验过，并且现在覆盖子代理/队友会话。**
> 实测口径：desktop 上 `standard` 预设配了 4 个 deny 名（`tencent-docs`、`office*`、
> `cangku-snapshots`、`blender-modeling`），一个**子代理**会话的目录从 30 条变成
> **模型可见 20 行 / 5,399 B**，4 个被隐藏的名字一个都没出现，而 `source.entries`
> 仍是 **30**（digest 稳定设计成立）。该会话**自己没有 `agent-preset/selected` 事件**，
> 靠的是 0.1.3 的父链回退。更早在隔离 profile 上：21 行 / 5,303 B → **2 行 / 1,158 B
> （−78.2%）**。**哪里都没测的是：整轮总字节，以及 spec 设想的 38 条场景**（真实测到的
> 目录分别是 21 / 30 / 17 条）。完整证据与仍未验的项：
> `cangku/261119_k4m_skillgate_report.md`。
## 一、它做什么

只挂两个钩子，别的什么都不干：

1. **改目录文本** —— 在 `agent/pre-step` 阶段，宿主把 `<available_skills>` 目录渲染出来之后，插件把属于被隐藏技能的那几行删掉。
2. **拦调用** —— 就算模型还是调了 `skill("office")`，这次调用会被拒绝，理由里写明是本预设的策略挡的。这一条可以单独关掉（`guard: false`）：目录照藏，调用放行。

插件**零工具、零系统提示段、零前端半边、零注入消息**。它存在的意义是省上下文，不能自己再占。

## 二、安装

`dsh-skill-gate` 是个纯宿主端的 bundle：包里带 `cordis.patch.yml`，那一行把插件注册为
`skill-gate`。按你装任何 DSH bundle 的方式装进目标 profile——把包放进该 profile 的
`node_modules`、在 profile 的 `bundles` 里登记——然后**重启一次宿主**。它没有前端半边，
浏览器里没有任何东西需要重新加载。

已验证的路径：`dsh-skill-gate@0.1.3` 镜像装进 desktop profile——**真目录，无 Junction 无
符号链接**——重启后日志里有 `[skill-gate] config loaded presets=standard`，没有
`did not activate`。想自己确认有没有激活，就看 stderr——激活失败的插件只打一行字，然后在
别的地方完全看不见。

## 三、配置——不配就不生效

只有一个文件：`$DSH_HOME/skill-gate.json`（`$DSH_HOME` 默认是 `~/.dsh`）。

**文件不存在 → 任何预设都不过滤，也不打日志。** 这就是交付后的默认状态。

包里的 `skill-gate.example.json` 是给你抄的模板，**插件从不读它**。

```json
{
  "version": 1,
  "presets": {
    "dev": {
      "mode": "allow",
      "names": ["plugin-work", "web-work", "motion-work", "dsh-plugin-dev",
                "cordis-composition-reference", "cangku-snapshots", "long-session-fold"]
    },
    "minimal": { "mode": "allow", "names": ["cangku-snapshots"] },
    "clerk":   { "mode": "deny",  "names": ["office*", "univer*"] },
    "scholar": { "enabled": false, "mode": "deny", "names": [] }
  }
}
```

**`mode`**

| 值 | 含义 |
|---|---|
| `allow` | 白名单：只保留 `names` 命中的技能，其余全藏 |
| `deny` | 黑名单：藏掉 `names` 命中的技能，其余全留 |

**`names`** —— 技能名，支持 `*` 通配：`office*`、`role-*`、`*work`。`*` 匹配任意长度（含零）的字符，且**整名匹配**——`office*` 命中 `office` 和 `office-xlsx`，不命中 `xoffice`。其余正则元字符一律按字面处理，`a.b` 只命中真的叫 `a.b` 的技能。

**`enabled`** —— 可选，默认 `true`。`{ "enabled": false }` 可以单独关掉某一个预设的过滤，不影响文件里其他条目；名单还在调、不想删的时候用它当开关。

**`guard`** —— 可选，默认 `true`。它单独管**拦不拦调用**，和上面的藏不藏目录是两件事：

| 值 | 效果 |
|---|---|
| `true`（默认） | 目录里看不到，模型硬调 `skill("X")` 也被拒 |
| `false` | 目录里照样看不到，但调用**放行**——模型如果从别处知道这个名字、或者用户用 `@技能名` 指过来，技能还能加载 |

`guard` 需 0.1.5 或更新版：旧版忽略该字段，仍拦截隐藏技能调用。配置改动在下一步生效；升级插件代码本身须重启宿主。

**没写进 `presets` 的预设，一个字都不改。** 这是最重要的一条：未配置的预设拿到的目录和宿主原生输出完全一致。

### 配置坏了会怎样

| 情况 | 行为 |
|---|---|
| 文件不存在 | **什么都不发生，也不 warn** —— 这是交付状态 |
| JSON 非法 | 全部预设放行，**打一条 warn** |
| 某一条预设写错（`mode` 不对 / `names` 不是字符串数组 / `enabled` 或 `guard` 不是布尔，含 `guard: null`） | **只丢这一条**并报出来，同一文件里其他条目照常生效 |
| 根不是对象 | 全部预设放行，打一条 warn |

这四条背后是同一条原则：配置坏掉绝不能让人手上一条技能都没有，也绝不能因为「某人还没配」就让宿主开始吵。

### 「隐藏」到底改的是什么

插件改的是目录消息的**文本**。机器可读的 `source.entries` 数组**故意一字不动**。

原因在宿主那边：`@deepseek-ai/dsh-tool-skill` 判断「目录变没变」时，哈希的是**从持久化会话事件里读回来的** `source.entries`（`catalogHistory`，`dsh-tool-skill/lib/index.js` 1065-1083）。如果插件把持久化的 entries 改小，持久化 digest 与实时 digest 每一步都对不上，宿主就会每一步重渲染一整份目录——正好与省字节相反。对着真模块实测：「entries 与文本同改」这一变体在第 2、3 步各多发一条 `update`（2,147 B → 2,010 B → 2,010 B，共三条目录事件，`cangku/tmp/k4m_node/k4m_gate1_matrix.txt:11-13`）。

所以：entries 保持全量，digest 保持稳定，模型眼里只剩留下的那几行。代价写在「已知局限」里。

## 四、怎么验证它真的生效了

1. **会话必须能解析到一个配过的预设 —— 这一条最容易踩。** 只有解析出预设 id 插件才动手：先后查该 agent 自己的 composition、本会话记录的预设、拉起它的父会话（最多 4 跳）。**子代理不需要自己有 `agent-preset/selected`**，它会从父会话继承。哪里都解析不到的会话会被原样放行，且是静默的。详见「已知局限」。
2. **看配置加载行。** 带预设的配置被读进来时，每个文件版本打一条 **info 级**：
   `[skill-gate] config loaded presets=standard`。看不到它，说明文件没找到、或者里面没有
   可用预设。
3. **看日志行。** 每一步真的过滤了，会打一条 **debug 级**的：
   ```
   [skill-gate] preset=dev mode=allow guard=on form=catalog kept=7/38 bytes=9917->2147
   ```
   `form` 是 `catalog`（首条目录）或 `update`（增量形态），`kept=7/38` 是保留条数/总条数，`bytes=9917->2147` 是文本改前改后的字节。**默认日志级别下看不到它**，要把 debug 打开。如果 debug 下也看不到这行，说明没有预设命中你的配置——先核对预设 id 拼写。
4. **看会话里的目录。** `<available_skills>` 块里应当只剩保留的技能。
5. **试调用拦截。** 让模型去用被隐藏的技能（在上面那份 `dev` 名单下试 `skill("office")`），调用必须被拒，理由是
   `技能「office」在本预设中被隐藏（dsh-skill-gate）`。拒绝文案是中文、目录空名单文案是英文——这是有意分工，见「已知局限」。
6. **未配置的预设不受影响。** 在配置里没出现的预设开一个会话，它的目录必须和禁用插件时逐字相同。
7. **坏配置。** 把 `{` 写进 `skill-gate.json`，开新会话：技能全在、会话正常跑完、只多一条 warn。

## 五、已知局限

**子代理现在也归它管——会话自己没选预设，照样可能被过滤。** 0.1.3 用三级回退链解析
预设：该 agent 自己的 composition → 本会话记录过的预设 → 最近的在世祖先会话（最多 4
跳）。所以一个**自己没有 `agent-preset/selected` 事件**的子代理或队友，会继承拉起它的
父会话的预设。那些「只以子代理形式跑」的预设（`dev`、`clerk`、`scholar`）正是靠这条才
真正被过滤。翻会话日志核对时要记住：子代理缺 `agent-preset/selected` 是**正常现象**，
不代表门被跳过。

**哪里都解析不到预设 → 不过滤，而且没有任何提示。** 如今还剩「未绑定」的，只剩**既没选
过预设、又没有能解析出预设的父链**的会话。插件通过预设注册表拿组合预设 id
（`dsh-agent-preset-registry/lib/index.js:734-736`，返回挂载的 `presetId`，会话没绑预设时
什么都不返回）。这类会话解析成 `""`，于是原样放行。这是安全的方向（拿不准就不藏），但
也意味着「装了插件、目录看起来没变」**不能**当成 bug 的证据。

**目录文本与 `source.entries` 不一致，这是设计取舍。** 任何读 `source.entries` 的地方仍然看得到全部技能，包括模型从没见过的那些。有直接实测：改写后文本里没有 `role-dev` 这一行，而存储的 entries 里它还在（`textHasRoleDev=false`、`storedHasRoleDev=true`，四步全是，`cangku/tmp/k4m_node/k4m_gate1_rotation.json`）。技能徽章这类消费者描述的图景因此和模型看到的不一样。这是稳定 digest 换来的代价。

**两条用户可见文案语种不同。** 空名单提示是英文——`- No skills are available in this preset (dsh-skill-gate)`——因为它替换的是宿主自己那段英文目录里的一行。guard 拒绝是中文——`技能「X」在本预设中被隐藏（dsh-skill-gate）`——因为它是一句错误原因，不是渲染出来的段落。两句都由本插件写，不是宿主写的。

**插件只看得到宿主渲染出来的东西。** 压根没进目录的技能不在它管辖范围内。`user-invocable` 技能也不归它管：它决定的是模型看得见什么、调得动什么，不是人能触发什么。

**`@技能名` 手势会连带受影响。** `scope-manager` 会把 `@技能名` 改写成 `/技能名`，当这条路径最终落到 `skill` 工具时，被隐藏的技能会被本插件的 guard 拦住。这是预期行为，但第一次遇到会意外。

**改动在下一个请求生效，不是立刻。** 配置的 mtime 或大小变了才会重读，每步检查一次。没有用 `fs.watch`，所以 Windows 上不会有句柄泄漏——但步与步之间也不会立刻响应。

**激活失败几乎看不出来。** Cordis 插件在 `apply()` 里抛错不会把宿主弄崩：宿主照常启动、往 stderr 打一行 warning，之后每个会话都当它没装。0.1.0 就是这样发的。如果门看起来什么都不做，先读 stderr，再查配置。

## 六、插件守住的几条底线

- 不改 `app.asar`，不改任何别的插件的 `node_modules`。
- 禁用或卸载 → 立刻回到原生行为，不留残留。
- **绝不往 Cordis context 上写属性。** 给未声明的属性赋值会在 `apply()` 里直接抛，而 Cordis 插件的失效形态是**插件完全不动、宿主照常启动、只留一行 warning**——0.1.0 就是这样发的。现在有两条回归测试和一处注入变异守着这条。
- 任何出错路径都只记日志并退化成「不过滤」。异常绝不逃出钩子：本插件是最外层的 `agent/pre-step` listener，抛出去会带崩整轮对话。
- 每步一次 `statSync`；过滤只是对一条已渲染消息做一遍数组扫描。

## 七、证据

| 什么 | 在哪 |
|---|---|
| 需求与基线测量 | `cangku/261119_k4m_skillgate_spec.md` |
| 门1 实验（矩阵 / 轮换 / 变异） | `cangku/tmp/261119_k4m_gate1.md`、`cangku/tmp/k4m_node/` |
| 实现与单测报告 | `cangku/tmp/261119_k4m_dev_report.md` |
| 验收报告 | `cangku/261119_k4m_skillgate_report.md` |

## 许可

MIT。
