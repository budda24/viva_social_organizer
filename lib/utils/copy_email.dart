import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';

/// Copies [email] to the clipboard and confirms with a brief toast.
///
/// Used for the contact-email chips. Copying behaves identically on every
/// device, unlike `mailto:` (does nothing on desktops with no default mail
/// app) or a Gmail-compose link (forces one provider / a Google sign-in).
Future<void> copyEmail(BuildContext context, String email) async {
  final messenger = ScaffoldMessenger.of(context);
  await Clipboard.setData(ClipboardData(text: email));
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(
    SnackBar(
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
    ),
  );
}
