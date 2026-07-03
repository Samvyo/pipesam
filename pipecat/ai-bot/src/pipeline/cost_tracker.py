from collections import defaultdict

class CostTracker:
    def __init__(self):
        self.rooms = defaultdict(lambda: {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "estimated_cost": 0.0
        })

    def update(self, room_id, input_tokens, output_tokens):
        total = input_tokens + output_tokens

        # Example pricing (replace with actual Claude pricing)
        input_cost = (input_tokens / 1_000_000) * 3.0
        output_cost = (output_tokens / 1_000_000) * 15.0

        room = self.rooms[room_id]
        room["input_tokens"] += input_tokens
        room["output_tokens"] += output_tokens
        room["total_tokens"] += total
        room["estimated_cost"] += input_cost + output_cost

    def get_room_stats(self, room_id):
        return self.rooms[room_id]