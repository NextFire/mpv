/*
 * Browser-friendly platform paths for Emscripten builds.
 *
 * This file is part of mpv.
 *
 * mpv is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * mpv is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with mpv.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <string.h>

#include "path.h"

const char *mp_get_platform_path_emscripten(void *talloc_ctx, const char *type)
{
    (void)talloc_ctx;

    if (strcmp(type, "home") == 0 ||
        strcmp(type, "cache") == 0 ||
        strcmp(type, "state") == 0)
        return "/mpv";

    if (strcmp(type, "desktop") == 0)
        return "/";

    return NULL;
}
