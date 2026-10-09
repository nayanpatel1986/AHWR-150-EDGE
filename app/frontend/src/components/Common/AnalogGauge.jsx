import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';

const AnalogGauge = ({
    value,
    min = 0,
    max = 100,
    label,
    unit,
    size = 200,
    startAngle = -135,
    endAngle = 135,
    majorTicks = 5,
    minorTicks = 4,
    color = '#38bdf8', // Default Cyan
    criticalLevel = 0.8, // 80% -> red danger band
    warnLevel = 0.65,    // 65% -> amber warn band
    subValue,
    subLabel,
    subValueInside = false,
    valueDecimals = 0,
    minSize = 160,
    maxSize = 320
}) => {
    const isResponsive = size === 'fill' || size === 'auto' || size === 'responsive';
    const containerRef = useRef(null);
    const [measuredSize, setMeasuredSize] = useState(typeof size === 'number' ? size : 200);

    const hasSubValue = subValue !== undefined && subValue !== null;

    useLayoutEffect(() => {
        if (!isResponsive || !containerRef.current || typeof ResizeObserver === 'undefined') return undefined;

        const node = containerRef.current;
        let frame = 0;
        const clamp = (next) => Math.max(minSize, Math.min(maxSize, next));

        const measure = () => {
            const rect = node.getBoundingClientRect();
            const subValueReserve = hasSubValue && !subValueInside ? 34 : 0;
            const usableHeight = rect.height > minSize ? rect.height - subValueReserve : rect.width;
            const next = Math.round(clamp(Math.min(rect.width || maxSize, usableHeight || maxSize)));
            setMeasuredSize((current) => (Math.abs(current - next) > 1 ? next : current));
        };

        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        });

        observer.observe(node);
        measure();

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [hasSubValue, isResponsive, maxSize, minSize, subValueInside]);

    const gaugeSize = isResponsive ? measuredSize : Number(size) || 200;

    // Calculations
    const numericValue = Number(value);
    const numericMin = Number(min);
    const numericMax = Number(max);
    const hasNumericValue = Number.isFinite(numericValue);
    const safeMin = Number.isFinite(numericMin) ? numericMin : 0;
    const safeMax = Number.isFinite(numericMax) && numericMax !== safeMin ? numericMax : safeMin + 1;
    const safeValue = hasNumericValue ? numericValue : safeMin;
    const radius = gaugeSize / 2;
    const center = gaugeSize / 2;
    const range = endAngle - startAngle;
    const valueRatio = Math.min(Math.max((safeValue - safeMin) / (safeMax - safeMin), 0), 1);
    const angle = startAngle + (valueRatio * range);

    // Alarm thresholds (as ratios of the dial). Needle/value turn red past critical.
    const isCritical = hasNumericValue && criticalLevel != null && valueRatio >= criticalLevel;
    const dangerColor = '#ef4444';
    const warnColor = '#fbbf24';
    const needleColor = isCritical ? dangerColor : color;

    // Polar to Cartesian
    const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
        const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
        return {
            x: centerX + (radius * Math.cos(angleInRadians)),
            y: centerY + (radius * Math.sin(angleInRadians))
        };
    };

    // Build a band arc (SVG path) covering [fromRatio, toRatio] of the dial.
    const arcRadius = radius - 6;
    const describeArc = (fromRatio, toRatio) => {
        const a0 = startAngle + (Math.min(Math.max(fromRatio, 0), 1) * range);
        const a1 = startAngle + (Math.min(Math.max(toRatio, 0), 1) * range);
        const start = polarToCartesian(center, center, arcRadius, a0);
        const end = polarToCartesian(center, center, arcRadius, a1);
        const largeArcFlag = (a1 - a0) > 180 ? 1 : 0;
        // Sweep clockwise (increasing angle).
        return `M ${start.x} ${start.y} A ${arcRadius} ${arcRadius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
    };

    const hasWarn = warnLevel != null && criticalLevel != null && warnLevel < criticalLevel;
    const safeValueDecimals = Math.max(0, Math.min(3, Number(valueDecimals) || 0));
    const formattedValue = hasNumericValue ? numericValue.toFixed(safeValueDecimals) : value;
    const valueY = center + (gaugeSize * 0.13);
    const unitY = center + (gaugeSize * 0.22);
    const labelY = center - (gaugeSize * 0.16);
    const subValueY = center + (gaugeSize * 0.36);
    const subLabelY = center + (gaugeSize * 0.43);
    const valueFontSize = gaugeSize * 0.15;
    const unitFontSize = gaugeSize * 0.064;
    const labelFontSize = gaugeSize * 0.048;
    const subValueFontSize = gaugeSize * 0.082;
    const subLabelFontSize = gaugeSize * 0.038;

    // Generate Ticks
    const ticks = [];
    const tickStep = (safeMax - safeMin) / majorTicks;

    for (let i = 0; i <= majorTicks; i++) {
        const tickValue = safeMin + (i * tickStep);
        const tickRatio = (tickValue - safeMin) / (safeMax - safeMin);
        const tickAngle = startAngle + (tickRatio * range);

        // Major Tick
        const p1 = polarToCartesian(center, center, radius - 10, tickAngle);
        const p2 = polarToCartesian(center, center, radius - 22, tickAngle);

        ticks.push(
            <line
                key={`major-${i}`}
                x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                stroke="white" strokeWidth="2"
            />
        );

        // Text labels are thinned on dense dials so they do not collide with live values.
        const showTickLabel = majorTicks <= 6 || i === 0 || i === majorTicks || i % 2 === 0;
        if (showTickLabel) {
            const textPos = polarToCartesian(center, center, radius - (gaugeSize * 0.18), tickAngle);
            ticks.push(
                <text
                    key={`text-${i}`}
                    x={textPos.x} y={textPos.y}
                    textAnchor="middle" alignmentBaseline="middle"
                    fill="#94a3b8" fontSize={gaugeSize * 0.055} fontWeight="bold"
                >
                    {Math.round(tickValue)}
                </text>
            );
        }

        // Minor Ticks between this major and the next
        if (i < majorTicks && minorTicks > 0) {
            const nextTickValue = min + ((i + 1) * tickStep);
            const minorStep = (nextTickValue - tickValue) / (minorTicks + 1);
            for (let j = 1; j <= minorTicks; j++) {
                const minorValue = tickValue + (j * minorStep);
                const minorRatio = (minorValue - min) / (max - min);
                const minorAngle = startAngle + (minorRatio * range);
                const mp1 = polarToCartesian(center, center, radius - 10, minorAngle);
                const mp2 = polarToCartesian(center, center, radius - 16, minorAngle);
                ticks.push(
                    <line
                        key={`minor-${i}-${j}`}
                        x1={mp1.x} y1={mp1.y} x2={mp2.x} y2={mp2.y}
                        stroke="#64748b" strokeWidth="1"
                    />
                );
            }
        }
    }

    // Needle
    const needleTip = polarToCartesian(center, center, radius - 25, angle);
    const needleBaseL = polarToCartesian(center, center, 5, angle - 90);
    const needleBaseR = polarToCartesian(center, center, 5, angle + 90);

    return (
        <Box
            ref={containerRef}
            sx={{
                width: isResponsive ? '100%' : gaugeSize,
                height: isResponsive ? '100%' : 'auto',
                minWidth: 0,
                minHeight: isResponsive ? minSize + (hasSubValue && !subValueInside ? 34 : 0) : 'auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center'
            }}
        >
            <Box sx={{ position: 'relative', width: gaugeSize, height: gaugeSize, flex: '0 0 auto', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <svg width={gaugeSize} height={gaugeSize} style={{ overflow: 'visible' }}>
                    {/* Gauge Background Ring */}
                    <circle cx={center} cy={center} r={radius - 5} fill="none" stroke="#1e293b" strokeWidth="4" />

                    {/* Alarm Bands: amber warn + red danger arcs */}
                    {hasWarn && warnLevel < 1 && (
                        <path
                            d={describeArc(warnLevel, Math.min(criticalLevel, 1))}
                            fill="none" stroke={warnColor} strokeWidth="4" strokeLinecap="butt" opacity="0.85"
                        />
                    )}
                    {criticalLevel != null && criticalLevel < 1 && (
                        <path
                            d={describeArc(criticalLevel, 1)}
                            fill="none" stroke={dangerColor} strokeWidth="4" strokeLinecap="butt" opacity="0.9"
                        />
                    )}

                    {/* Ticks */}
                    {ticks}

                    {/* Needle */}
                    <path
                        d={`M ${needleBaseL.x} ${needleBaseL.y} L ${needleTip.x} ${needleTip.y} L ${needleBaseR.x} ${needleBaseR.y} Z`}
                        fill={needleColor}
                        stroke="black"
                        strokeWidth="1"
                        filter="drop-shadow(0px 2px 2px rgba(0,0,0,0.5))"
                    />
                    <circle cx={center} cy={center} r="6" fill="#334155" stroke="white" strokeWidth="1" />

                    <text
                        x={center}
                        y={labelY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={color}
                        fontSize={labelFontSize * 1.3}
                        fontWeight="900"
                        letterSpacing="1"
                        style={{ filter: `drop-shadow(0px 0px 4px ${color}60)` }}
                    >
                        {String(label || '').toUpperCase()}
                    </text>

                    <text
                        x={center}
                        y={valueY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={isCritical ? dangerColor : 'white'}
                        fontSize={valueFontSize}
                        fontWeight="800"
                        style={{ filter: 'drop-shadow(0px 2px 2px rgba(0,0,0,0.65))' }}
                    >
                        {formattedValue}
                    </text>

                    <text
                        x={center}
                        y={unitY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#94a3b8"
                        fontSize={unitFontSize}
                        fontWeight="500"
                    >
                        {unit}
                    </text>

                    {hasSubValue && subValueInside && (
                        <>
                            <line
                                x1={center - (gaugeSize * 0.23)}
                                x2={center + (gaugeSize * 0.23)}
                                y1={center + (gaugeSize * 0.30)}
                                y2={center + (gaugeSize * 0.30)}
                                stroke="#334155"
                                strokeWidth="1"
                            />
                            <text
                                x={center}
                                y={subValueY}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="#bef264"
                                fontSize={subValueFontSize}
                                fontWeight="800"
                            >
                                {subValue}
                            </text>
                            <text
                                x={center}
                                y={subLabelY}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="#94a3b8"
                                fontSize={subLabelFontSize}
                                fontWeight="600"
                            >
                                {subLabel || ''}
                            </text>
                        </>
                    )}
                </svg>
            </Box>

            {hasSubValue && !subValueInside && (
                <Box sx={{ mt: -1.5, minWidth: gaugeSize * 0.52, px: 1, py: 0.45, borderTop: '1px solid #334155', textAlign: 'center' }}>
                    <Typography variant="body2" noWrap sx={{ color: '#bef264', fontWeight: 'bold', fontSize: `${gaugeSize * 0.105}px`, lineHeight: 1 }}>
                        {subValue}
                    </Typography>
                    <Typography variant="caption" noWrap sx={{ color: '#94a3b8', fontSize: `${gaugeSize * 0.04}px`, display: 'block' }}>
                        {subLabel || ''}
                    </Typography>
                </Box>
            )}
        </Box>
    );
};

export default AnalogGauge;
