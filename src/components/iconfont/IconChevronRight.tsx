import React from 'react';

import { getIconColor } from './helper';

interface IconChevronRightProps {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  [key: string]: any;
}

const DEFAULT_STYLE: React.CSSProperties = {
  display: 'block',
};

const IconChevronRight: React.FC<IconChevronRightProps> = ({
  size = 18,
  color,
  style: _style,
  ...rest
}) => {
  const style = _style ? { ...DEFAULT_STYLE, ..._style } : DEFAULT_STYLE;

  return (
    <svg viewBox="0 0 1024 1024" width={size + 'px'} height={size + 'px'} style={style} {...rest}>
      <path
        d="M542.976 499.2l-225.28-225.28a52.288 52.288 0 1 1 73.984-73.984l263.168 262.144a52.224 52.224 0 0 1 0 73.984L391.68 799.488a52.288 52.288 0 1 1-73.984-73.984L542.976 499.2z"
        fill={getIconColor(color, 0, '#00B4D8')}
      />
    </svg>
  );
};

export default IconChevronRight;
