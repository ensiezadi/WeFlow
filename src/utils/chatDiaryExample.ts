/** Fictional conversations for exploring the diary without loading private data. */
export function diaryExampleFiles(): File[] {
  const at = (time: string) => Date.parse(`2026-10-18T${time}:00+08:00`) / 1000
  const make = (name: string, wxid: string, displayName: string, messages: unknown[]) => new File([
    JSON.stringify({ session: { wxid, displayName }, messages })
  ], name, { type: 'application/json' })
  const msg = (id: string, senderUsername: string, senderDisplayName: string, time: string, content: string, replyToMessageId = '') => ({
    platformMessageId: id, senderUsername, senderDisplayName, createTime: at(time), content, replyToMessageId
  })
  return [
    make('示例-项目群.json', 'demo-project@chatroom', '项目小组 · 示例', [
      msg('g1', 'demo-lin', '小林', '09:15', '周末的分享会定在下午三点，我们先把演示稿过一遍。'),
      msg('g2', 'demo-zhou', '小周', '09:18', '我准备案例，小林帮忙看看流程有没有遗漏。', 'g1'),
      msg('g3', 'demo-me', '我', '09:23', '我负责把大家的内容串成一个完整的故事。')
    ]),
    make('示例-小林私聊.json', 'demo-lin', '与小林的对话 · 示例', [
      msg('p1', 'demo-me', '我', '18:30', '下午的分享会顺利结束了，你觉得问答环节怎么样？'),
      msg('p2', 'demo-lin', '小林', '18:34', '大家对小周的案例很感兴趣。下次我们可以留更多讨论时间。', 'p1')
    ])
  ]
}
