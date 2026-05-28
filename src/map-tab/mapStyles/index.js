import heatmap   from './heatmap.js';
import bubbles   from './bubbles.jsx';
import arcs      from './arcs.jsx';
import treasure  from './treasure.jsx';
import pushpins  from './pushpins.jsx';

export const styles = [heatmap, bubbles, arcs, treasure, pushpins];

export const stylesById = Object.fromEntries(styles.map(s => [s.id, s]));
