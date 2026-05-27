import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

class UserAvatarChip extends StatelessWidget {
  const UserAvatarChip({super.key, required this.name, this.avatarUrl});

  final String name;
  final String? avatarUrl;

  @override
  Widget build(BuildContext context) {
    final hasPhoto = avatarUrl != null && avatarUrl!.isNotEmpty;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 28,
          height: 28,
          child: hasPhoto
              ? ClipOval(
                  child: Image.network(
                    avatarUrl!,
                    width: 28,
                    height: 28,
                    fit: BoxFit.cover,
                    errorBuilder: (_, _, _) => _initial(),
                  ),
                )
              : _initial(),
        ),
        const SizedBox(width: 10),
        Text(
          name,
          style: const TextStyle(
            color: AppColors.ink,
            fontSize: 13,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );
  }

  Widget _initial() {
    return Container(
      width: 28,
      height: 28,
      decoration: const BoxDecoration(
        color: AppColors.accentSoft,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        name.isEmpty ? '?' : name.characters.first,
        style: const TextStyle(
          color: AppColors.ink,
          fontWeight: FontWeight.w600,
          fontSize: 12,
        ),
      ),
    );
  }
}
