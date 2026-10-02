#pragma once
#include "fx_host.h"
typedef enum {
  k_user_revfx_param_time = 0,
  k_user_revfx_param_depth,
  k_user_revfx_param_reserved0,
  k_user_revfx_param_shift_depth,
  k_num_user_revfx_param_id
} user_revfx_param_id_t;
#define REVFX_INIT _hook_init
#define REVFX_PROCESS _hook_process
#define REVFX_SUSPEND _hook_suspend
#define REVFX_RESUME _hook_resume
#define REVFX_PARAM _hook_param
