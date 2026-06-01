import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';
import 'open_link.dart';

/// Contact-via-email action for the email chips/links.
///
/// Opens the OS mail composer (`mailto:`) — what testers expect when they tap an
/// address. If the platform can't launch it (e.g. a desktop with no default mail
/// app), it falls back to copying the address with a toast, so the tap is never
/// a dead end. Previously this only copied, which read as "nothing happens".
Future<void> emailAction(BuildContext context, String email) async {
  final messenger = ScaffoldMessenger.of(context);
  bool opened = false;
  try {
    opened = await openLink(Uri(scheme: 'mailto', path: email));
  } catch (_) {
    opened = false;
  }
  if (opened) return;
  await Clipboard.setData(ClipboardData(text: email));
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(_copiedSnack(email));
}

/// Copies [email] to the clipboard and confirms with a brief toast.
Future<void> copyEmail(BuildContext context, String email) async {
  final messenger = ScaffoldMessenger.of(context);
  await Clipboard.setData(ClipboardData(text: email));
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(_copiedSnack(email));
}

SnackBar _copiedSnack(String email) {
  return SnackBar(
    behavior: SnackBarBehavior.floating,
    backgroundColor: AppColors.cardBg,
    duration: const Duration(seconds: 2),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
      side: const BorderSide(color: AppColors.cardBorder),
    ),
    content: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.check_circle_outline, size: 18, color: AppColors.statusGreen),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            'Copied $email',
            style: const TextStyle(color: AppColors.ink, fontSize: 13),
          ),
        ),
      ],
    ),
  );
}
