/// Channel deep-link configuration.
///
/// Telegram: clicking `t.me/<bot>?start=<code>` opens the bot chat with a
/// "Start" button that, when tapped, sends `/start <code>` — which our
/// telegramWebhook function consumes to bind the chat to the user.
///
/// WhatsApp: Twilio Sandbox requires the user to first message the shared
/// number with `join <code>` to opt in. The wa.me deep link pre-fills that.
library;

class ChannelLinks {
  ChannelLinks._();

  // Telegram primary channel.
  static const String telegramBotUsername = 'VivaTribuBot';

  // Twilio WhatsApp Sandbox fallback.
  // Update these when you swap to a production Twilio number.
  static const String twilioSandboxNumber = '14155238886';
  static const String twilioSandboxJoinCode = 'test-disappear';

  /// Deep link that opens Telegram, lands on the bot, and (on Start) sends
  /// `/start <inviteCode>` — binding this chat to the invited user.
  static Uri telegramJoin(String inviteCode) {
    final code = inviteCode.toUpperCase();
    return Uri.parse('https://t.me/$telegramBotUsername?start=$code');
  }

  /// Deep link that opens WhatsApp with `join <code>` pre-filled — the
  /// message the user must send once to join the Twilio sandbox.
  static Uri whatsAppJoin() {
    final text = Uri.encodeComponent('join $twilioSandboxJoinCode');
    return Uri.parse('https://wa.me/$twilioSandboxNumber?text=$text');
  }
}
