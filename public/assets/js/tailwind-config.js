        window.tailwind = window.tailwind || {};
        window.tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['"IBM Plex Sans Arabic"', '"Plus Jakarta Sans"', 'sans-serif'],
                        mono: ['"JetBrains Mono"', 'monospace'],
                        arabic: ['"IBM Plex Sans Arabic"', 'sans-serif'],
                    },
                    colors: {
                        sage: {
                            50:  '#f6f9f6', 100: '#e8f1e9', 200: '#d1e3d3', 300: '#aacdb0',
                            400: '#7cae87', 500: '#558f62', 600: '#3f7249', 700: '#345b3c',
                            800: '#2c4932', 900: '#253d2c',
                        },
                        mist: {
                            50:  '#fafbfa', 100: '#f3f5f3', 200: '#e8ebe8', 300: '#d5dad6',
                            400: '#a8b0a9', 500: '#7c857d', 600: '#5b635c', 700: '#454b46',
                            800: '#343835', 900: '#252825',
                        },
                    },
                    boxShadow: {
                        'soft': '0 1px 2px rgba(45, 60, 48, 0.04), 0 4px 12px rgba(45, 60, 48, 0.04)',
                        'soft-lg': '0 2px 4px rgba(45, 60, 48, 0.05), 0 12px 32px rgba(45, 60, 48, 0.06)',
                        'soft-xl': '0 4px 8px rgba(45, 60, 48, 0.06), 0 20px 48px rgba(45, 60, 48, 0.08)',
                        'floating': '0 12px 36px -4px rgba(37, 61, 44, 0.12), 0 4px 12px rgba(37, 61, 44, 0.06)',
                    },
                    animation: {
                        'fade-in': 'fadeIn 0.4s ease-out',
                        'slide-up': 'slideUp 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)',
                        'dot-bounce': 'dotBounce 1.4s infinite ease-in-out',
                        'pulse-soft': 'pulseSoft 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                        'mic-pulse': 'micPulse 1.5s ease-in-out infinite',
                    },
                    keyframes: {
                        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
                        slideUp: {
                            '0%': { opacity: '0', transform: 'translateY(12px)' },
                            '100%': { opacity: '1', transform: 'translateY(0)' },
                        },
                        dotBounce: {
                            '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: '0.35' },
                            '40%': { transform: 'scale(1)', opacity: '1' },
                        },
                        pulseSoft: {
                            '0%, 100%': { opacity: '1' },
                            '50%': { opacity: '0.55' },
                        },
                        micPulse: {
                            '0%, 100%': { transform: 'scale(1)', opacity: '1' },
                            '50%': { transform: 'scale(1.15)', opacity: '0.7' },
                        }
                    },
                }
            }
        }
