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
      "Chao ban, minh la The Little Coder AI Bot. Gui /help de xem cac lenh co san."
    )
  );

  bot.help((ctx) => {
    ctx.reply("Lenh hien tai: /start, /help");
  });

  bot.launch().then(() => {
    console.log("[bot] Telegram bot started");
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

module.exports = { startTelegramBot };
