class MatchedHuman {
  final String name;
  final String city;
  final String description;
  final String? avatarUrl;

  const MatchedHuman({
    required this.name,
    required this.city,
    required this.description,
    this.avatarUrl,
  });
}
