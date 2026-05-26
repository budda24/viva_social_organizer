class Attendee {
  final String name;
  final String description;
  final String location;
  final String? avatarUrl;

  const Attendee({
    required this.name,
    required this.description,
    required this.location,
    this.avatarUrl,
  });
}
