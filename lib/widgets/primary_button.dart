import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon = Icons.arrow_forward,
    this.leading,
    this.fullWidth = false,
    this.shape = ButtonShape.pill,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final Widget? leading;
  final bool fullWidth;
  final ButtonShape shape;

  @override
  Widget build(BuildContext context) {
    final radius = shape == ButtonShape.pill ? 999.0 : 14.0;
    final padding = shape == ButtonShape.pill
        ? const EdgeInsets.symmetric(horizontal: 28, vertical: 16)
        : const EdgeInsets.symmetric(horizontal: 24, vertical: 20);

    final content = Padding(
      padding: padding,
      child: Row(
        mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (leading != null) ...[
            leading!,
            const SizedBox(width: 12),
          ],
          Text(
            label,
            style: const TextStyle(
              color: AppColors.accentInk,
              fontWeight: FontWeight.w600,
              fontSize: 15,
            ),
          ),
          if (icon != null) ...[
            if (fullWidth) const Spacer(),
            if (!fullWidth) const SizedBox(width: 10),
            Icon(icon, size: 18, color: AppColors.accentInk),
          ],
        ],
      ),
    );

    final button = Material(
      color: AppColors.accent,
      borderRadius: BorderRadius.circular(radius),
      child: InkWell(
        borderRadius: BorderRadius.circular(radius),
        onTap: onPressed,
        child: content,
      ),
    );

    return fullWidth ? SizedBox(width: double.infinity, child: button) : button;
  }
}

enum ButtonShape { pill, rounded }
