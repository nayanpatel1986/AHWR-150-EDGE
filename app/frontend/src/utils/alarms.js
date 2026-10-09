// Shared alarm presentation helpers. Color is NEVER the only cue: callers also
// render the priority text chip (P1/P2/P3) and the state text.

// Priority -> color. P1 red, P2 amber/orange, P3 yellow.
export const PRIORITY_COLORS = {
    P1: '#ef4444',
    P2: '#f59e0b',
    P3: '#eab308',
};

export function priorityColor(priority) {
    return PRIORITY_COLORS[priority] || '#64748b';
}

// Human label for the alarm state machine.
export function stateLabel(state) {
    switch (state) {
        case 'UNACK': return 'Unacknowledged';
        case 'ACK': return 'Acknowledged';
        case 'RTN_UNACK': return 'Returned (unack)';
        default: return state || '--';
    }
}

// Order for sorting: P1 first.
export function priorityRank(priority) {
    return { P1: 0, P2: 1, P3: 2 }[priority] ?? 9;
}
