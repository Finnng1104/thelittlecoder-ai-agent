const { Telegraf } = require("telegraf");

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log("[bot] TELEGRAM_BOT_TOKEN is missing, bot is disabled");
    return null;
  }

  const bot = new Telegraf(token);

  bot.start((ctx) =>
    ctx.reply(
      "Chào bạn, mình là The Little Coder AI Bot. Gửi /help để xem các lệnh có sẵn nhé!",
    ),
  );

  bot.help((ctx) => {
    ctx.reply("Lệnh đang có hiện tại: /start, /help");
  });

  bot.launch().then(() => {
    console.log("[bot] Telegram bot started");
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

module.exports = { startTelegramBot };
