# my-miniapp

## 命令

```bash
npm install
npm run hb-sdk -- login
npm run hb-sdk -- remote create
# 已有远端小程序时改用：npm run hb-sdk -- remote bind <mini-program-id>
npm run dev
npm run build
npm run deploy -- --release-note "更新说明"
```

`package.json#heybox.category` 初始声明为 `other`（其他）。发布前请按实际用途选择 `tool`（工具）、`game`（游戏）或 `other`（其他）；该字段为必填，修改后需重新构建。

发布前请补充 `package.json#heybox.desc`，描述已实现的主要功能和适用场景。模板不预填简介，以免占位文案被当作真实介绍发布。

如果小程序服务于特定 PC 游戏，可运行 `npm run hb-sdk -- remote games search "游戏名" --json` 查询平台游戏 appid，核对结果后填写 `package.json#heybox.bindAppIds`（字符串数组）。工具类应主动检查，通用工具可保持为空。关联游戏随版本审核，修改后需重新构建；能否绑定以部署预检为准。

`package.json#heybox.platforms` 默认声明全平台 `android`、`ios`、`ohos`、`windows`、`macos`，请按项目实际完成适配并验收的平台保留，未适配的平台务必删除。`linux` 目前没有客户端基线与 API 兼容声明，暂不建议声明。

更多内容见 [CLI 指南](https://docs.xiaoheihe.cn/hb_sdk/guide/cli) 和 [SDK 文档](https://docs.xiaoheihe.cn/hb_sdk/)。
