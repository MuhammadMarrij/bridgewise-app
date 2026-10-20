'use client';

/**
 * English / 中文 switch.
 *
 * translates rendered text nodes and placeholder/aria-label/title by
 * exact match against ZH, re-applied on every DOM change. Static UI text is
 * covered; sentences assembled from data (insights, guided replies) stay in
 * English. Upgrade path: t() at the call sites if those need translating too.
 */
import { useEffect, useState } from 'react';

const ZH: Record<string, string> = {
  // shell
  'Loading your account…': '正在加载您的账户…',
  'Every action is approved by you. Rates: ECB and live provider quotes. Balances held in BridgeWise’s own ledger.': '每一笔操作都由您批准。汇率来自欧洲央行和实时机构报价。余额记录在 BridgeWise 自己的账本中。',
  'Ask BridgeWise': '问 BridgeWise', 'Assistant': '助手', 'Home': '首页', 'Wallet': '钱包', 'Cards & accounts': '卡与账户',
  'Activity': '交易记录', 'Send': '汇款', 'Budget': '预算', 'Credit': '信用', 'Bills': '账单', 'Markets': '汇率行情', 'Main': '主导航',
  'Here is where your money stands today.': '这是您今天的资金状况。',
  'One pocket per currency, valued at live rates.': '每种货币一个账户，按实时汇率估值。',
  'Tuition and fees — read from your invoice, paid on your approval.': '学费与杂费——从您的账单中读取，经您批准后支付。',
  'Send money': '汇款', 'To family, friends and landlords — and what the market would charge you.': '汇给家人、朋友和房东——并查看市场上的真实费用。',
  'Every movement on every pocket, with the balance after it.': '每个账户的每笔资金变动，以及变动后的余额。',
  'Build credit in China': '在中国建立信用', 'Bank cards, Alipay, WeChat Pay and bank accounts linked to your wallet.': '已关联到钱包的银行卡、支付宝、微信支付和银行账户。',
  'Where your money goes, and how long it will last.': '您的钱花在哪里，还能用多久。', 'The exchange rates that matter to you.': '与您相关的汇率。',
  'Good morning': '早上好', 'Good afternoon': '下午好', 'Good evening': '晚上好', 'Sign out': '退出登录', 'Skip to content': '跳到正文',
  // approval card
  'Done': '已完成', 'Decline': '拒绝', 'You sell': '卖出', 'You get': '得到', 'Rate': '汇率', 'Mid-market (ECB)': '中间价（欧洲央行）',
  'Our fee': '我们的手续费', 'Arrives': '到账', 'You pay': '您支付', 'Left in pocket': '账户剩余', 'They receive': '对方收到', 'Reference': '附言',
  'From': '从', 'To': '到', 'It costs you': '您的花费', 'Fee': '手续费', 'Pay': '支付', 'Due': '截止日期', 'Approving…': '正在批准…', 'Approve': '批准',
  'Prepared by your assistant': '由您的助手准备', 'Prepared by you': '由您准备', 'expired': '已过期', 'declined': '已拒绝', 'failed': '失败',
  // assistant
  'BridgeWise Assistant': 'BridgeWise 助手', 'BridgeWise assistant': 'BridgeWise 助手', 'Working on it…': '处理中…', 'Message the assistant': '给助手发消息',
  'Close assistant': '关闭助手', 'Ask anything, or paste an invoice…': '随便问，或粘贴一张账单…', 'Close': '关闭',
  'Live AI model': '实时 AI 模型', 'Guided mode · same tools, no live model': '引导模式 · 相同工具，未连接实时模型', 'Prepares actions · you approve': '准备操作 · 由您批准',
  "What's my situation?": '我的财务状况如何？', 'Pay my tuition': '支付我的学费', 'How is my exchange rate doing?': '我的汇率走势如何？', 'Cheapest way to send money': '最便宜的汇款方式',
  'read your accounts': '读取了您的账户', 'checked ECB rates': '查询了欧洲央行汇率', 'compared 17 providers': '比较了 17 家机构', 'read the invoice': '读取了账单',
  'saved the bill': '保存了账单', 'prepared payment': '准备了付款', 'prepared conversion': '准备了换汇', 'set an alert': '设置了提醒', 'read your statement': '读取了您的流水',
  'analysed your spending': '分析了您的支出', 'checked your recipients': '查看了收款人', 'prepared transfer': '准备了转账', 'set a budget': '设置了预算',
  'checked linked accounts': '查看了关联账户', 'prepared withdrawal': '准备了提现', 'checked your credit plan': '查看了您的信用计划', 'Spending by category': '按类别的支出',
  // onboarding
  'Your money, across borders, handled.': '跨境的钱，一站搞定。',
  'One account for every currency you live in — linked to Alipay, WeChat Pay, your bank cards and your bank back home. An AI assistant that reads your tuition invoices, watches exchange rates, builds your credit in China and prepares every payment — and never moves money without your approval.':
    '一个账户管理您生活中的每一种货币——关联支付宝、微信支付、您的银行卡和家乡的银行。AI 助手读取您的学费账单、关注汇率、帮您在中国建立信用并准备每一笔付款——未经您批准，绝不动用资金。',
  'Create account': '创建账户', 'Sign in': '登录', 'Email': '邮箱', 'Password': '密码', 'At least 8 characters, with letters and a number.': '至少 8 位，包含字母和数字。',
  'Your first name': '您的名字', 'Money from home': '家乡的钱', 'Money where you study': '留学地的钱',
  'Starting balances are test funds in BridgeWise’s ledger. Rates and provider quotes are live.': '初始余额是 BridgeWise 账本中的测试资金。汇率和机构报价均为实时数据。',
  'From Pakistan, studying in China': '来自巴基斯坦，在中国留学', 'From India, studying in China': '来自印度，在中国留学', 'From China, studying in the UK': '来自中国，在英国留学',
  'From Pakistan, studying in the US': '来自巴基斯坦，在美国留学', 'Account': '账户', 'Home currency': '家乡货币', 'Study currency': '留学地货币', 'Student': '学生',
  'CNY, PKR, INR, GBP, USD and more — valued at live ECB rates': '人民币、卢比、英镑、美元等——按欧洲央行实时汇率估值',
  'Link Alipay 支付宝, WeChat Pay 微信支付, UnionPay and Visa cards, CCB, ICBC and BOC': '关联支付宝、微信支付、银联和 Visa 卡、建设银行、工商银行和中国银行',
  'Paste a tuition invoice; the assistant sets up the payment and protects your living money': '粘贴学费账单，助手会准备付款并保护您的生活费',
  'Every action is a card you approve. The assistant cannot execute anything.': '每个操作都是一张需要您批准的卡片。助手无法自行执行任何操作。',
  'Please wait…': '请稍候…', 'Create my account': '创建我的账户',
  // home / wallet
  'Total across your pockets': '所有账户合计', 'Add money': '充值', 'Convert': '换汇', 'Pockets': '货币账户', 'Manage': '管理', 'BridgeWise noticed': 'BridgeWise 提醒您',
  'Updated just now': '刚刚更新', 'Waiting for your approval': '等待您批准', 'Upcoming bills': '即将到期的账单', 'Add bill': '添加账单', 'Recent transactions': '最近交易',
  'See all': '查看全部', 'Nothing yet.': '暂无记录。', 'Statement': '流水', 'Convert between pockets': '账户间换汇', 'Live rate · 0.30% fee, shown up front': '实时汇率 · 0.30% 手续费，提前显示',
  'Indicative · live rates from': '参考值 · 实时汇率来源：', 'Explain': '解释', 'Analyse': '分析', 'Plan': '规划', 'Prepare payment': '准备付款',
  'Display currency': '显示货币', 'Rate unavailable': '汇率暂不可用', 'Getting quote…': '正在报价…', 'Get quote': '获取报价',
  // bills
  'Add a bill from your invoice': '从账单添加', 'Read by parser, checked by you': '由解析器读取，由您核对', 'Invoice text': '账单文本', 'Let the assistant handle it': '交给助手处理',
  'Check what we read': '核对读取结果', 'Amount': '金额', 'Pay to': '收款方', 'We’ll refuse any payment that leaves you less to live on.': '任何会让您生活费不足的付款都会被拒绝。',
  'Cancel': '取消', 'Your bills': '您的账单', 'No bills yet.': '暂无账单。', 'Sent': '已发送', 'Tuition': '学费', 'Reading…': '读取中…', 'Read invoice': '读取账单',
  'Saving…': '保存中…', 'Save and prepare payment': '保存并准备付款', 'Nothing due — every bill is paid.': '没有待付款项——所有账单都已支付。',
  'No bills yet. Paste your tuition invoice into the assistant and it will set up the payment.': '暂无账单。把学费账单粘贴给助手，它会为您准备付款。', 'Bill currency': '账单货币',
  // compare
  'Compare real providers': '比较真实机构', 'Live quotes': '实时报价', 'They should receive': '对方应收到', 'You pay in': '支付货币', 'Must arrive by': '最晚到账日期',
  'Cheapest that arrives in time': '按时到账中最便宜的', 'You send': '您汇出', 'Choosing the worst usable option would cost': '选择最差的可用方案将多花',
  'more for the same transfer.': '（同一笔转账）。', 'Provider': '机构', 'Rate margin': '汇率差价', 'Arrival': '到账', 'Verdict': '结论', 'Best': '最佳', 'Usable': '可用',
  'Checking 17 providers…': '正在查询 17 家机构…', 'Compare': '比较', 'Bank': '银行', 'Transfer provider': '汇款机构', 'Too slow': '太慢', 'Eats reserve': '占用生活费',
  'Over balance': '超出余额', 'Not usable': '不可用', 'Receive currency': '收款货币',
  // markets
  'Daily ECB reference rates · last 30 days': '欧洲央行每日参考汇率 · 最近 30 天', 'Alert me at': '到达此汇率时提醒我', 'Set alert': '设置提醒',
  'Ask the assistant': '问助手', 'Your currencies': '您的货币', 'Your alerts': '您的提醒', 'The ECB does not publish this pair; live rate only.': '欧洲央行不发布此货币对，仅提供实时汇率。',
  'Loading…': '加载中…',
  // add money / activity / send / budget
  'Linked account': '关联账户', 'Test funds (no linked account)': '测试资金（无关联账户）',
  'Link a card, Alipay, WeChat Pay or bank in Cards & accounts to add money from it.': '在“卡与账户”中关联银行卡、支付宝、微信支付或银行，即可从中充值。',
  'Where': '商户', 'Category': '类别', 'All': '全部', 'All categories': '全部类别', 'No transactions match.': '没有匹配的交易。', 'Send to a person': '汇款给个人',
  'Name': '姓名', 'Relationship': '关系', 'Receives in': '收款货币', 'Country code': '国家代码',
  'Only you can add recipients. The assistant can send only to people saved here — so no message or invoice can trick it into paying a new account.': '只有您可以添加收款人。助手只能汇款给这里保存的人——任何消息或账单都无法诱骗它向新账户付款。',
  'Save recipient': '保存收款人', 'No recipients yet. Add the people you send money to.': '暂无收款人。请添加您要汇款的人。', 'Pay from': '付款账户', 'Best pocket': '最优账户',
  'Paying a big bill? See what the market charges': '要支付大额账单？看看市场收费', 'Spent, last 30 days': '最近 30 天支出', 'Average per day': '日均',
  'Your money lasts': '您的钱还能用', 'at this pace, excluding tuition': '按当前速度，不含学费', 'Where it went': '花在哪里', 'Ask for advice': '寻求建议', '30 days': '30 天',
  'No spending yet. Pay with BridgeWise and it appears here.': '暂无支出。用 BridgeWise 付款后会显示在这里。', 'Monthly budgets': '每月预算', 'No budgets yet.': '暂无预算。',
  'Set budget': '设置预算', 'How': '方式', 'Currency': '货币', 'Pay with BridgeWise': '用 BridgeWise 付款', 'Pocket': '账户', 'Transfer from home bank': '从家乡银行转入',
  'Adding…': '充值中…', 'Paying…': '付款中…', 'New recipient': '新收款人', 'Quoting…': '报价中…', 'Mum': '妈妈',
  'How much did I spend this month, and where can I cut back?': '我这个月花了多少钱？哪里可以节省？', 'Move out': '转出', 'Remove': '移除',
  'tuition': '学费', 'rent': '房租', 'food': '餐饮', 'transport': '交通', 'bills': '账单', 'shopping': '购物', 'family': '家庭', 'fx': '换汇', 'income': '收入', 'other': '其他',
  // accounts
  'Sandbox connectors.': '沙箱连接器。',
  'Cards are validated exactly as an acquirer would (network, Luhn, expiry, security code) and tokenised — the full number is never stored. Live Alipay, WeChat Pay and bank connections plug into the same connector once merchant credentials are issued. Test cards:':
    '银行卡按收单机构的标准校验（卡组织、Luhn、有效期、安全码）并令牌化——绝不存储完整卡号。取得商户资质后，真实的支付宝、微信支付和银行连接接入同一连接器。测试卡：',
  'works,': '可用，', 'Linked cards and accounts': '已关联的卡和账户', 'Nothing linked yet. Add a bank card, Alipay, WeChat Pay or a bank account below.': '尚未关联。请在下方添加银行卡、支付宝、微信支付或银行账户。',
  'Link something new': '添加新关联', 'Card number': '卡号', 'Expiry': '有效期', 'Security code': '安全码', 'Name on card': '持卡人姓名', 'Card currency': '卡币种',
  'Real name on the account': '账户实名', 'Card / account number': '卡号 / 账号', 'Account holder': '账户持有人',
  'BridgeWise stores a token, the network and the last four digits only. Your full card number and security code are never saved.': 'BridgeWise 仅保存令牌、卡组织和卡号后四位。绝不保存完整卡号和安全码。',
  'Type': '类型', 'Card': '卡', 'Bank card': '银行卡', 'Alipay': '支付宝', 'WeChat Pay': '微信支付', 'Bank account': '银行账户',
  'Alipay account (mobile or email)': '支付宝账号（手机号或邮箱）', 'Mobile number bound to WeChat Pay': '绑定微信支付的手机号', 'Linking…': '关联中…', 'Link': '关联',
  // credit
  'Credit-readiness': '信用准备度', 'Your next step': '下一步', 'Every step done. Keep paying on time.': '所有步骤已完成。请继续按时付款。',
  'Detected from your BridgeWise account': '从您的 BridgeWise 账户自动识别', 'Loading your credit plan…': '正在加载您的信用计划…', 'Foundations': '基础',
  'How do I build credit in China as a foreign student? What should I do next?': '作为外国留学生，我如何在中国建立信用？下一步该做什么？', 'Undo': '撤销', 'Mark done': '标记完成',
  'Open a Chinese bank account and link its debit card': '开设中国银行账户并关联借记卡',
  'Link Alipay and complete real-name verification (实名认证) with your passport': '关联支付宝并用护照完成实名认证',
  'Link WeChat Pay with real-name verification': '关联微信支付并完成实名认证', 'Build a record of paying bills on time': '建立按时付款记录',
  'Stay within your monthly budgets': '控制在每月预算之内', 'Keep at least two months of living costs in reserve': '保留至少两个月的生活费',
  'Check your PBOC credit report once a year': '每年查询一次人民银行征信报告',
  'After a few months of history, ask your bank about a student or secured credit card': '积累几个月记录后，向银行咨询学生卡或担保信用卡',
  // pay
  'Amount (CNY)': '金额（人民币）', 'You’ll pay on Alipay’s own page. BridgeWise credits your CNY pocket only after Alipay confirms the trade.': '您将在支付宝官方页面付款。支付宝确认交易后，BridgeWise 才会为您的人民币账户入账。',
  'The card field is Stripe’s own. Test card 4242 4242 4242 4242, any future date, any CVC.': '卡号输入框由 Stripe 提供。测试卡 4242 4242 4242 4242，任意未来日期，任意 CVC。',
  'Opening Alipay…': '正在打开支付宝…', 'Pay with Alipay 支付宝': '使用支付宝付款', 'Processing…': '处理中…', 'Continue to card': '继续填写银行卡',
};

const ATTRS = ['placeholder', 'aria-label', 'title'] as const;

function translate(root: Node) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = root; n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.parentElement?.closest('textarea,[data-no-translate]')) continue;
      const raw = n.nodeValue ?? '';
      const zh = ZH[raw.replace(/\s+/g, ' ').trim()];
      if (zh) n.nodeValue = raw.replace(raw.trim(), zh);
    } else if (n instanceof Element && !n.closest('[data-no-translate]')) {
      for (const a of ATTRS) { const v = n.getAttribute(a); const zh = v && ZH[v]; if (zh) n.setAttribute(a, zh); }
    }
  }
}

export function getLang(): 'en' | 'zh' {
  try { return localStorage.getItem('bw-lang') === 'zh' ? 'zh' : 'en'; } catch { return 'en'; }
}

export function LangSwitch() {
  const [lang, setLang] = useState<'en' | 'zh'>('en');
  useEffect(() => {
    const l = getLang();
    setLang(l);
    if (l !== 'zh') return;
    document.documentElement.lang = 'zh-CN';
    translate(document.body);
    // Our own writes come back as mutations too; they no longer match ZH, so they stop there.
    const obs = new MutationObserver((ms) => { for (const m of ms) translate(m.target); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
    return () => obs.disconnect();
  }, []);
  const flip = () => { try { localStorage.setItem('bw-lang', lang === 'zh' ? 'en' : 'zh'); } catch { /* private mode */ } window.location.reload(); };
  return (
    <button className="lang-switch" onClick={flip} data-no-translate aria-label={lang === 'zh' ? 'Switch to English' : '切换到中文'}>
      {lang === 'zh' ? 'EN' : '中文'}
    </button>
  );
}
